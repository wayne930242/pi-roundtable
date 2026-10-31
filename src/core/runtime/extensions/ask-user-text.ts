import { type OwnerIdentity, ownerWords, PRONOUNS } from "../../identity.ts";
import type {
	OwnerAnswer,
	OwnerQuestion,
	Questionnaire,
	QuestionnaireAnswer,
} from "../../interactions/prompts.ts";

/** The longest a question's name is when it has no header, in characters. */
const NAME_CHARS = 120;

/**
 * When a question truly blocks a yolo turn: the one case it may end waiting for the answer. Shared
 * by the unanswered result and the yolo note, so the two never say it differently.
 */
function trulyBlocks(o: ReturnType<typeof ownerWords>): string {
	return `Only a question that truly blocks may end your turn: one with no safe choice without the answer, such as an irreversible or outward-facing step whose direction only ${o.he} can pick. Then first finish every part of the work the answer does not affect, and end your turn saying what you are waiting for.`;
}

/**
 * The note a yolo turn's system prompt carries: work on without waiting for the owner, and end the
 * turn with a question only when it truly blocks.
 */
export function yoloAskNote(owner: OwnerIdentity): string {
	const o = ownerWords(owner);
	return `Yolo mode is on in this conversation: keep working without waiting for ${o.name}, and do not end your turn with a question. When an ask_user card goes unanswered, go on with your recommended option, or your best judgment where you offered none, and say in your reply what you assumed; ${o.his} later answer comes in a new turn to correct course. ${trulyBlocks(o)}`;
}

/**
 * The tool's result: what the owner chose and wrote. `yolo`: the turn's conversation is in yolo
 * mode, so a question not answered in its short wait does not end the turn.
 */
export function answerText(
	answer: OwnerAnswer | "pending" | "declined" | undefined,
	owner: OwnerIdentity,
	yolo = false,
): string {
	const o = ownerWords(owner);
	if (answer === "declined")
		return `${o.name} cancelled the question on its card without answering. Do not ask the same question again. Continue without the answer, or, if you cannot go on without it, end your turn saying so.`;
	if (answer === "pending" && yolo)
		return `${o.name} has not answered yet, and yolo mode is on in this conversation, so keep working: do not end your turn and do not ask again. Go on with your recommended option, or your best judgment where you offered none, and say in your reply what you assumed. The card stays open; if ${o.he} answers later, a new turn brings you the answer and you correct course from there. ${trulyBlocks(o)}`;
	if (answer === "pending")
		return `${o.name} has not answered yet. The card stays open, so do not ask again and do not wait for it. End your turn now: say briefly that you are waiting for ${o.his} answer on the card. When ${o.he} answers, a new turn brings you the answer and you continue from there.`;
	if (!answer)
		return `No answer: ${o.name} did not answer. Go on without it if you safely can, otherwise ask in your reply.`;
	const lines = [
		...(answer.choices.length > 0
			? [`${o.name} chose: ${answer.choices.join("; ")}`]
			: []),
		...(answer.text !== undefined ? [`${o.name} wrote: ${answer.text}`] : []),
	];
	return lines.length > 0 ? lines.join("\n") : `${o.name} chose nothing.`;
}

/**
 * The tool's result while the server restarts: open cards live in its memory and are gone after
 * the restart, so a new card is not posted (`opened` false) and one still waiting will be lost.
 */
export function restartingText(owner: OwnerIdentity, opened: boolean): string {
	const o = ownerWords(owner);
	return `${opened ? `${o.name} has not answered yet, and the server is restarting: the card closes with it, so ${o.his} answer cannot reach you through it.` : `The server is restarting, so no card was posted: a card would not survive the restart.`} Do not call ask_user again in this turn. Write the question as your final answer instead; it is posted to this channel for ${o.him} to read, and ${o.his} answer comes in a new turn.`;
}

/** The turn a late answer starts: the question it answers and what was chosen and written. */
export function lateAnswerText(
	question: string,
	answer: OwnerAnswer,
	by: string,
): string {
	return `(${by} answered your earlier ask_user question on its card, after your turn had ended. Continue from where you stopped, with this answer.)\nQuestion: ${question}\n${answerText(answer, { name: by, pronouns: PRONOUNS.they })}`;
}

/** How a question is named in a result: its header, else its text cut short. */
function nameOf(question: OwnerQuestion): string {
	if (question.header) return question.header;
	const chars = Array.from(question.question.replace(/\s+/g, " ").trim());
	return chars.length <= NAME_CHARS
		? chars.join("")
		: `${chars.slice(0, NAME_CHARS - 1).join("")}…`;
}

function lineOf(answer: OwnerAnswer | undefined) {
	const parts = [
		...(answer && answer.choices.length > 0
			? [`chose ${answer.choices.join("; ")}`]
			: []),
		...(answer?.text !== undefined ? [`Wrote: ${answer.text}`] : []),
	];
	return parts.length > 0 ? parts.join(". ") : "not answered";
}

/** One numbered line per question, then the note. */
function listOf(
	questionnaire: Questionnaire,
	answer: QuestionnaireAnswer,
): string[] {
	return [
		...questionnaire.questions.map(
			(question, i) =>
				`${i + 1}. ${nameOf(question)}: ${lineOf(answer.answers[i])}`,
		),
		...(answer.note !== undefined ? [`Note: ${answer.note}`] : []),
	];
}

/** The tool's result for a questionnaire: each question's answer, and the note; `yolo` as for `answerText`. */
export function questionnaireText(
	answer: QuestionnaireAnswer | "pending" | "declined" | undefined,
	questionnaire: Questionnaire,
	owner: OwnerIdentity,
	yolo = false,
): string {
	if (answer === "pending" || answer === "declined" || !answer)
		return answerText(answer, owner, yolo);
	return [
		`${owner.name} answered your questions on the card:`,
		...listOf(questionnaire, answer),
	].join("\n");
}

/** The turn a late questionnaire answer starts: the same list, under a line saying when it came. */
export function lateQuestionnaireText(
	questionnaire: Questionnaire,
	answer: QuestionnaireAnswer,
	by: string,
): string {
	return [
		`(${by} answered your earlier ask_user questions on their card, after your turn had ended. Continue from where you stopped, with these answers.)`,
		...listOf(questionnaire, answer),
	].join("\n");
}

/**
 * The result of questions asked one at a time on a surface that takes one: what was answered
 * before the first that was not (`stopped` says how it ended), and the questions not asked.
 */
export function sequentialText(
	asked: Questionnaire,
	answers: readonly OwnerAnswer[],
	stopped: "pending" | "declined" | "unanswered" | undefined,
	owner: OwnerIdentity,
	stoppedText: string,
): string {
	const notAsked = asked.questions.slice(
		answers.length + (stopped === undefined ? 0 : 1),
	);
	return [
		...(answers.length > 0
			? [
					`${owner.name} answered your questions on the card:`,
					...asked.questions
						.slice(0, answers.length)
						.map(
							(question, i) =>
								`${i + 1}. ${nameOf(question)}: ${lineOf(answers[i])}`,
						),
				]
			: []),
		...(stopped === undefined
			? []
			: [
					`${
						asked.questions.length > 1
							? `${answers.length + 1}. ${nameOf(asked.questions[answers.length] as OwnerQuestion)}: `
							: ""
					}${stoppedText}`,
				]),
		...(notAsked.length > 0
			? [
					`Not asked: ${notAsked
						.map(
							(question, i) =>
								`${answers.length + (stopped === undefined ? 0 : 1) + i + 1}. ${nameOf(question)}`,
						)
						.join(
							"; ",
						)}; this channel takes one question at a time, so ask again if you still need them.`,
				]
			: []),
	].join("\n");
}
