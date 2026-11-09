import { useState } from "react";
import type {
	PromptAnswer,
	PromptFrame,
	PromptOption,
	PromptQuestion,
} from "../../src/api-types.ts";
import { translate as t } from "../lib/messages.ts";
import type { CardState } from "../lib/rooms.ts";
import {
	Collapse,
	describeAnswer,
	Shell,
	useAnswering,
} from "./cards-shell.tsx";

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

export function Field(props: {
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
			<div className="options" data-swipe-ignore>
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

export function AskCard({
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

export function QuestionnaireCard({
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
