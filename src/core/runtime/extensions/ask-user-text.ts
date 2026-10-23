import { type OwnerIdentity, ownerWords, PRONOUNS } from "../../identity.ts";
import type {
	OwnerAnswer,
	OwnerQuestion,
	Questionnaire,
	QuestionnaireAnswer,
} from "../../interactions/prompts.ts";

/** The longest a question's name is when it has no header, in characters. */
const NAME_CHARS = 120;

/** The tool's result: what the owner chose and wrote. */
export function answerText(
	answer: OwnerAnswer | "pending" | "declined" | undefined,
	owner: OwnerIdentity,
): string {
	const o = ownerWords(owner);
	if (answer === "declined")
		return `${o.name} cancelled the question on its card without answering. Do not ask the same question again. Continue without the answer, or, if you cannot go on without it, end your turn saying so.`;
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

/** The tool's result for a questionnaire: each question's answer, and the note. */
export function questionnaireText(
	answer: QuestionnaireAnswer | "pending" | "declined" | undefined,
	questionnaire: Questionnaire,
	owner: OwnerIdentity,
): string {
	if (answer === "pending" || answer === "declined" || !answer)
		return answerText(answer, owner);
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
