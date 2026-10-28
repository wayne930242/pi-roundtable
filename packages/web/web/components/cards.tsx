import { memo, useEffect, useRef, useState } from "react";
import type {
	ClientFrame,
	PromptAnswer,
	PromptFrame,
	PromptOption,
	PromptOutcome,
	PromptQuestion,
} from "../../src/api-types.ts";
import { useRoomAccent } from "../lib/characters.ts";
import { when } from "../lib/format.ts";
import { useLook } from "../lib/look.ts";
import { translate as t, wording } from "../lib/messages.ts";
import type { CardState } from "../lib/rooms.ts";
import { useConnection } from "../lib/socket.ts";
import { toast } from "../lib/toast.ts";
import { Icon } from "./icons.tsx";
import { MessageMarkdown } from "./message-markdown.tsx";

const OUTCOMES: Record<PromptOutcome, string> = {
	approved: wording("Approved"),
	declined: wording("Declined"),
	answered: wording("Answered"),
	expired: wording("Expired"),
	cancelled: wording("Cancelled"),
	withdrawn: wording("Withdrawn"),
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

/**
 * What a card sends and whether it waits for the server. The buttons lock only once the frame
 * was sent; a frame that could not go says so and leaves them as they were, and a refusal of the
 * answer (counted on the card) gives them back.
 */
function useAnswering(card: CardState) {
	const connection = useConnection();
	const [sent, setSent] = useState(false);
	const refused = card.refused ?? 0;
	useEffect(() => {
		if (refused > 0) setSent(false);
	}, [refused]);
	const send = (frame: ClientFrame): boolean => {
		if (!connection.send(frame)) {
			toast(
				t("Not connected right now. Try again when the connection is back."),
				"danger",
			);
			return false;
		}
		setSent(true);
		return true;
	};
	return { sent, send };
}

/** The answer as the card shows it after it ended: the options picked, then the person's own words. */
export function describeAnswer(answer: PromptAnswer): string {
	const text = answer.text?.trim();
	return [...answer.choices, ...(text ? [text] : [])].join(", ");
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

/**
 * The wax seal an approved approval card keeps under the Camelot look: in the room agent's
 * accent, with the agent's own mark pressed into it. It is stamped in (`stamp`) only when the card
 * turns approved while the page shows it; a card the room shows already approved keeps the seal
 * still. The card says "Approved" in words, so the seal is decoration.
 */
function WaxSeal({ room, stamp }: { room: string; stamp: boolean }) {
	const accent = useRoomAccent(room);
	return (
		<span
			className="wax-seal"
			data-stamp={stamp ? "true" : undefined}
			style={accent}
			aria-hidden="true"
		>
			<svg viewBox="0 0 40 40" aria-hidden="true" focusable="false">
				<path
					className="seal-body"
					d="M37.4 21.9Q36.3 23.7 36.6 25.9Q37.0 28.2 35.0 29.3Q33.0 30.4 32.4 32.5Q31.7 34.6 29.5 34.9Q27.3 35.2 25.7 36.6Q24.1 37.9 22.0 37.4Q20.0 37.0 18.0 37.4Q15.9 37.9 14.3 36.6Q12.6 35.3 10.6 34.8Q8.6 34.4 7.8 32.4Q7.0 30.4 5.1 29.2Q3.2 28.1 3.2 26.0Q3.2 23.8 2.4 21.9Q1.6 20.0 2.6 18.1Q3.6 16.3 3.4 14.1Q3.1 11.8 4.7 10.5Q6.4 9.2 7.4 7.3Q8.3 5.3 10.5 5.0Q12.7 4.8 14.2 3.1Q15.8 1.4 17.9 2.4Q20.0 3.4 22.1 2.4Q24.2 1.5 25.8 3.2Q27.3 4.8 29.4 5.2Q31.5 5.6 32.3 7.6Q33.1 9.6 34.9 10.8Q36.7 12.0 36.8 14.1Q36.8 16.2 37.7 18.1Q38.6 20.0 37.4 21.9Z"
				/>
				<circle className="seal-ring" cx="20" cy="20" r="12.5" />
				<path className="seal-mark" d="M13.5 20.5l4.6 4.6 8.6-9.6" />
			</svg>
		</span>
	);
}

function Shell(props: {
	card: CardState;
	timeZone: string;
	tone: "action" | "timeout" | "ask";
	icon: "shield" | "timer" | "sparkle";
	title: string;
	children: React.ReactNode;
}) {
	const { card } = props;
	const late = "late" in card.frame && card.frame.late;
	const { timeZone } = props;
	const ended = [
		card.by,
		card.closedAt ? when(card.closedAt, timeZone) : undefined,
	].filter(Boolean);
	const sealed =
		useLook() === "camelot" &&
		card.frame.kind === "approval" &&
		card.outcome === "approved";
	// Whether the card was approved already when this one mounted (a room entered again, a pane switched back to).
	const approvedOnMount = useRef(card.outcome === "approved");
	return (
		<article
			className={`prompt prompt-${props.tone}`}
			data-ended={card.outcome ? "true" : undefined}
			data-sealed={sealed ? "true" : undefined}
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
			{card.outcome && ended.length > 0 ? (
				<p className="prompt-meta">{ended.join(" · ")}</p>
			) : null}
			{props.children}
			{sealed ? (
				<WaxSeal room={card.room} stamp={!approvedOnMount.current} />
			) : null}
		</article>
	);
}

function ApprovalCard({
	card,
	timeZone,
	frame,
}: {
	card: CardState;
	timeZone: string;
	frame: Extract<PromptFrame, { kind: "approval" }>;
}) {
	const { sent, send } = useAnswering(card);
	const timeout = frame.purpose === "turn-timeout";
	const answer = (approved: boolean) =>
		send({ type: "approval", prompt: frame.id, approved });
	const { approval } = frame;
	return (
		<Shell
			card={card}
			timeZone={timeZone}
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
			{approval?.copy && !card.outcome ? (
				<CopyButton copy={approval.copy} />
			) : null}
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
						{frame.wording?.decline ??
							(timeout ? t("Stop turn") : t("Decline"))}
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
	timeZone,
	frame,
}: {
	card: CardState;
	timeZone: string;
	frame: Extract<PromptFrame, { kind: "ask" }>;
}) {
	const { sent, send } = useAnswering(card);
	const [pick, setPick] = useState<Chosen>(NO_PICK);
	const [given, setGiven] = useState<PromptAnswer>();
	const question: PromptQuestion = {
		question: frame.question,
		options: frame.options,
		multi: frame.multi,
		allowOther: frame.allowOther,
	};
	const answer = answerOf(question, pick);
	// What the server kept of the answer, which a reloaded page has; the page's own is shown before it arrives.
	const shown = card.answer?.kind === "ask" ? card.answer.answer : given;
	return (
		<Shell
			card={card}
			timeZone={timeZone}
			tone="ask"
			icon="sparkle"
			title={frame.title}
		>
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
						onClick={() => send({ type: "cancel", prompt: frame.id })}
					>
						{t("Cancel")}
					</button>
					<button
						type="button"
						disabled={sent || !answer}
						onClick={() => {
							if (answer && send({ type: "answer", prompt: frame.id, answer }))
								setGiven(answer);
						}}
					>
						{t("Send answer")}
					</button>
				</div>
			</Collapse>
			{card.outcome === "answered" && shown ? (
				<p className="prompt-answer">{describeAnswer(shown)}</p>
			) : null}
		</Shell>
	);
}

function QuestionnaireCard({
	card,
	timeZone,
	frame,
}: {
	card: CardState;
	timeZone: string;
	frame: Extract<PromptFrame, { kind: "questionnaire" }>;
}) {
	const { sent, send } = useAnswering(card);
	const [given, setGiven] = useState<string[]>();
	const [picks, setPicks] = useState<Chosen[]>(() =>
		frame.questions.map(() => NO_PICK),
	);
	const [note, setNote] = useState("");
	const answers = frame.questions.map((question, index) =>
		answerOf(question, picks[index] ?? NO_PICK),
	);
	// What the server kept of the answers, which a reloaded page has; the page's own are shown before they arrive.
	const kept = card.answer?.kind === "questionnaire" ? card.answer : undefined;
	const lines = kept
		? [
				...kept.answers.map((one) => (one ? describeAnswer(one) : "—")),
				...(kept.note ? [kept.note] : []),
			]
		: given;
	return (
		<Shell
			card={card}
			timeZone={timeZone}
			tone="ask"
			icon="sparkle"
			title={frame.title}
		>
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
				{frame.questions.some((question) => question.options.length > 0) ? (
					<label>
						{t("Add a note")}
						<textarea
							rows={2}
							value={note}
							disabled={sent}
							onChange={(event) => setNote(event.target.value)}
						/>
					</label>
				) : null}
				<div className="actions">
					<button
						type="button"
						className="secondary"
						disabled={sent}
						onClick={() => send({ type: "cancel", prompt: frame.id })}
					>
						{t("Cancel")}
					</button>
					<button
						type="button"
						disabled={sent || answers.every((one) => !one)}
						onClick={() => {
							const sentNote = note.trim();
							const sentOk = send({
								type: "answers",
								prompt: frame.id,
								answers: answers.map((one) => one ?? null),
								...(sentNote ? { note: sentNote } : {}),
							});
							if (sentOk)
								setGiven(
									answers.map((one) => (one ? describeAnswer(one) : "—")),
								);
						}}
					>
						{t("Send answers")}
					</button>
				</div>
			</Collapse>
			{card.outcome === "answered" && lines ? (
				<ul className="prompt-answer">
					{lines.map((line, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: the lines follow the card's fixed questions
						<li key={index}>{line}</li>
					))}
				</ul>
			) : null}
		</Shell>
	);
}

/** One card of a room: open, waiting for the person, or ended and kept as a record. */
export const PromptCard = memo(function PromptCard({
	card,
	timeZone,
}: {
	card: CardState;
	/** The zone the time it ended is shown in. */
	timeZone: string;
}) {
	const { frame } = card;
	switch (frame.kind) {
		case "approval":
			return <ApprovalCard card={card} timeZone={timeZone} frame={frame} />;
		case "ask":
			return <AskCard card={card} timeZone={timeZone} frame={frame} />;
		case "questionnaire":
			return (
				<QuestionnaireCard card={card} timeZone={timeZone} frame={frame} />
			);
	}
});
