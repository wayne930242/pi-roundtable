import { memo, useState } from "react";
import type {
	PromptAnswer,
	PromptFrame,
	PromptOption,
	PromptOutcome,
	PromptQuestion,
} from "../../src/api-types.ts";
import { translate as t } from "../lib/messages.ts";
import type { CardState } from "../lib/rooms.ts";
import { useConnection } from "../lib/socket.ts";
import { Icon } from "./icons.tsx";
import { MessageMarkdown } from "./message-markdown.tsx";

const OUTCOMES: Record<PromptOutcome, string> = {
	approved: "Approved",
	declined: "Declined",
	answered: "Answered",
	expired: "Expired",
	cancelled: "Cancelled",
	withdrawn: "Withdrawn",
};

/** What the card says after it ended. */
function outcomeText(card: CardState): string {
	const { frame, outcome } = card;
	if (!outcome) return "";
	if (frame.kind === "approval" && frame.wording) {
		if (outcome === "approved") return frame.wording.approved;
		if (outcome === "declined") return frame.wording.declined;
	}
	const base = t(OUTCOMES[outcome]);
	return card.note ? `${base}: ${card.note}` : base;
}

/** Shows or hides the card's buttons with a height change that follows the card's end. */
function Collapse({
	open,
	children,
}: {
	open: boolean;
	children: React.ReactNode;
}) {
	return (
		<div className="collapse" data-open={open}>
			<div className="collapse-inner" inert={!open}>
				{children}
			</div>
		</div>
	);
}

function Shell(props: {
	card: CardState;
	tone: "action" | "timeout" | "ask";
	icon: "shield" | "timer" | "sparkle";
	title: string;
	children: React.ReactNode;
}) {
	const { card } = props;
	const late = "late" in card.frame && card.frame.late;
	return (
		<article
			className={`prompt prompt-${props.tone}`}
			data-ended={card.outcome ? "true" : undefined}
			aria-label={props.title}
		>
			<header className="prompt-head">
				<span className="prompt-icon">
					<Icon name={props.icon} size={18} />
				</span>
				<strong>{props.title}</strong>
				{late && !card.outcome ? (
					<span className="badge badge-warn">{t("Late")}</span>
				) : null}
				{card.outcome ? (
					<span className="prompt-outcome" data-outcome={card.outcome}>
						<Icon
							name={
								card.outcome === "approved" || card.outcome === "answered"
									? "check"
									: "close"
							}
							size={14}
						/>
						{outcomeText(card)}
					</span>
				) : null}
			</header>
			{props.children}
		</article>
	);
}

function ApprovalCard({
	card,
	frame,
}: {
	card: CardState;
	frame: Extract<PromptFrame, { kind: "approval" }>;
}) {
	const connection = useConnection();
	const [sent, setSent] = useState(false);
	const timeout = frame.purpose === "turn-timeout";
	const answer = (approved: boolean) => {
		setSent(true);
		connection.send({ type: "approval", prompt: frame.id, approved });
	};
	const { approval } = frame;
	return (
		<Shell
			card={card}
			tone={timeout ? "timeout" : "action"}
			icon={timeout ? "timer" : "shield"}
			title={frame.title}
		>
			<MessageMarkdown source={frame.message} />
			{approval ? (
				<details className="prompt-details">
					<summary>{t("Details")}</summary>
					<dl className="facts">
						<div>
							<dt>{t("Tool")}</dt>
							<dd>{approval.tool}</dd>
						</div>
						<div>
							<dt>{t("Action")}</dt>
							<dd>{approval.action}</dd>
						</div>
					</dl>
					{Object.keys(approval.input).length ? (
						<pre className="prompt-input">
							{JSON.stringify(approval.input, null, 2)}
						</pre>
					) : null}
					{approval.files?.length ? (
						<ul className="prompt-files">
							{approval.files.map((file) => (
								<li key={file.path}>
									<Icon name="file" size={14} />
									<code>{file.path}</code>
									{file.bytes === undefined ? null : (
										<span className="meta">{file.bytes} B</span>
									)}
								</li>
							))}
						</ul>
					) : null}
					{approval.truncated ? (
						<p className="hint">
							{t(
								"Long values are cut here; the action runs with the full text.",
							)}
						</p>
					) : null}
				</details>
			) : null}
			{approval?.copy ? <CopyButton copy={approval.copy} /> : null}
			{frame.speakerOnly ? (
				<p className="hint">
					{t("Only the person this turn answers can approve it.")}
				</p>
			) : null}
			{frame.approvers?.length ? (
				<p className="hint">
					{t("{names} can approve this, and so can an owner.", {
						names: frame.approvers.join(", "),
					})}
				</p>
			) : null}
			{frame.late && !card.outcome ? (
				<p className="hint">
					{t(
						"The turn stopped waiting. Your answer starts a new turn in this room.",
					)}
				</p>
			) : null}
			<Collapse open={!card.outcome}>
				<div className="actions">
					<button
						type="button"
						className="secondary"
						disabled={sent}
						onClick={() => answer(false)}
					>
						{frame.wording?.decline ?? (timeout ? t("Stop") : t("Decline"))}
					</button>
					<button type="button" disabled={sent} onClick={() => answer(true)}>
						{frame.wording?.approve ?? (timeout ? t("Continue") : t("Approve"))}
					</button>
				</div>
				{frame.wording?.footer ? (
					<p className="hint">{frame.wording.footer}</p>
				) : null}
			</Collapse>
		</Shell>
	);
}

function CopyButton({
	copy,
}: {
	copy: { label?: string | undefined; text: string };
}) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			className="secondary copy-action"
			onClick={() => {
				navigator.clipboard
					?.writeText(copy.text)
					.then(() => {
						setCopied(true);
						setTimeout(() => setCopied(false), 1400);
					})
					.catch(() => undefined);
			}}
		>
			<Icon name={copied ? "check" : "copy"} size={16} />
			{copied
				? t("Copied")
				: copy.label
					? t("Copy {label}", { label: copy.label })
					: t("Copy")}
		</button>
	);
}

// ── Questions ────────────────────────────────────────────────────────────────────────────────────

/** What the person has picked for one question so far. */
export interface Chosen {
	choices: string[];
	other: boolean;
	text: string;
}
export const NO_PICK: Chosen = { choices: [], other: false, text: "" };

/** The answer a pick makes, or undefined while it is not one. */
export function answerOf(
	question: Pick<PromptQuestion, "options" | "multi" | "allowOther">,
	pick: Chosen,
): PromptAnswer | undefined {
	const text = pick.text.trim();
	if (question.options.length === 0)
		return text ? { choices: [], text } : undefined;
	const choices = pick.choices;
	if (pick.other && !text) return undefined;
	if (choices.length === 0 && !pick.other) return undefined;
	return { choices, ...(pick.other ? { text } : {}) };
}

function Field(props: {
	name: string;
	question: PromptQuestion;
	pick: Chosen;
	onChange(next: Chosen): void;
	disabled: boolean;
}) {
	const { question, pick, onChange } = props;
	const [previewing, setPreviewing] = useState<string>();
	if (question.options.length === 0)
		return (
			<fieldset className="field" disabled={props.disabled}>
				<legend>
					{question.header ? `${question.header} · ` : ""}
					{question.question}
				</legend>
				<textarea
					rows={2}
					value={pick.text}
					onChange={(event) => onChange({ ...pick, text: event.target.value })}
					aria-label={question.question}
				/>
			</fieldset>
		);
	const toggle = (option: PromptOption) => {
		const has = pick.choices.includes(option.label);
		if (question.multi)
			onChange({
				...pick,
				choices: has
					? pick.choices.filter((label) => label !== option.label)
					: [...pick.choices, option.label],
			});
		else onChange({ choices: [option.label], other: false, text: pick.text });
		setPreviewing(option.label);
	};
	const preview = question.options.find(
		(option) => option.label === previewing,
	)?.preview;
	return (
		<fieldset className="field" disabled={props.disabled}>
			<legend>
				{question.header ? `${question.header} · ` : ""}
				{question.question}
			</legend>
			<div className="options">
				{question.options.map((option) => (
					<label
						key={option.label}
						className="option"
						data-checked={pick.choices.includes(option.label)}
					>
						<input
							type={question.multi ? "checkbox" : "radio"}
							name={props.name}
							checked={pick.choices.includes(option.label)}
							onChange={() => toggle(option)}
						/>
						<span>
							<strong>{option.label}</strong>
							{option.description ? (
								<span className="meta">{option.description}</span>
							) : null}
						</span>
					</label>
				))}
				{question.allowOther ? (
					<label className="option" data-checked={pick.other}>
						<input
							type={question.multi ? "checkbox" : "radio"}
							name={props.name}
							checked={pick.other}
							onChange={() =>
								onChange(
									question.multi
										? { ...pick, other: !pick.other }
										: { choices: [], other: true, text: pick.text },
								)
							}
						/>
						<span>
							<strong>{t("Other")}</strong>
						</span>
					</label>
				) : null}
			</div>
			{pick.other ? (
				<input
					type="text"
					value={pick.text}
					placeholder={t("Your answer")}
					aria-label={t("Your answer")}
					onChange={(event) => onChange({ ...pick, text: event.target.value })}
				/>
			) : null}
			{preview ? <pre className="option-preview">{preview}</pre> : null}
		</fieldset>
	);
}

function AskCard({
	card,
	frame,
}: {
	card: CardState;
	frame: Extract<PromptFrame, { kind: "ask" }>;
}) {
	const connection = useConnection();
	const [pick, setPick] = useState<Chosen>(NO_PICK);
	const [sent, setSent] = useState(false);
	const question: PromptQuestion = {
		question: frame.question,
		options: frame.options,
		multi: frame.multi,
		allowOther: frame.allowOther,
	};
	const answer = answerOf(question, pick);
	return (
		<Shell card={card} tone="ask" icon="sparkle" title={frame.title}>
			<Collapse open={!card.outcome}>
				<Field
					name={frame.id}
					question={question}
					pick={pick}
					onChange={setPick}
					disabled={sent}
				/>
				<div className="actions">
					<button
						type="button"
						className="secondary"
						disabled={sent}
						onClick={() => {
							setSent(true);
							connection.send({ type: "cancel", prompt: frame.id });
						}}
					>
						{t("Cancel")}
					</button>
					<button
						type="button"
						disabled={sent || !answer}
						onClick={() => {
							if (!answer) return;
							setSent(true);
							connection.send({ type: "answer", prompt: frame.id, answer });
						}}
					>
						{t("Send answer")}
					</button>
				</div>
			</Collapse>
		</Shell>
	);
}

function QuestionnaireCard({
	card,
	frame,
}: {
	card: CardState;
	frame: Extract<PromptFrame, { kind: "questionnaire" }>;
}) {
	const connection = useConnection();
	const [picks, setPicks] = useState<Chosen[]>(() =>
		frame.questions.map(() => NO_PICK),
	);
	const [note, setNote] = useState("");
	const [sent, setSent] = useState(false);
	const answers = frame.questions.map((question, index) =>
		answerOf(question, picks[index] ?? NO_PICK),
	);
	return (
		<Shell card={card} tone="ask" icon="sparkle" title={frame.title}>
			<Collapse open={!card.outcome}>
				{frame.questions.map((question, index) => (
					<Field
						// biome-ignore lint/suspicious/noArrayIndexKey: the questions of a card never reorder
						key={index}
						name={`${frame.id}-${index}`}
						question={question}
						pick={picks[index] ?? NO_PICK}
						onChange={(next) =>
							setPicks((current) =>
								current.map((one, at) => (at === index ? next : one)),
							)
						}
						disabled={sent}
					/>
				))}
				<label>
					{t("Add a note")}
					<textarea
						rows={2}
						value={note}
						disabled={sent}
						onChange={(event) => setNote(event.target.value)}
					/>
				</label>
				<div className="actions">
					<button
						type="button"
						className="secondary"
						disabled={sent}
						onClick={() => {
							setSent(true);
							connection.send({ type: "cancel", prompt: frame.id });
						}}
					>
						{t("Cancel")}
					</button>
					<button
						type="button"
						disabled={sent || answers.every((one) => !one)}
						onClick={() => {
							setSent(true);
							connection.send({
								type: "answers",
								prompt: frame.id,
								answers: answers.map((one) => one ?? null),
								...(note.trim() ? { note: note.trim() } : {}),
							});
						}}
					>
						{t("Send answers")}
					</button>
				</div>
			</Collapse>
		</Shell>
	);
}

/** One card of a room: open, waiting for the person, or ended and kept as a record. */
export const PromptCard = memo(function PromptCard({
	card,
}: {
	card: CardState;
}) {
	const { frame } = card;
	switch (frame.kind) {
		case "approval":
			return <ApprovalCard card={card} frame={frame} />;
		case "ask":
			return <AskCard card={card} frame={frame} />;
		case "questionnaire":
			return <QuestionnaireCard card={card} frame={frame} />;
	}
});
