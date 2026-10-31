import { messages } from "../i18n/index.ts";
import type { OwnerIdentity } from "../identity.ts";
import type { OwnerAnswer, Prompts } from "../interactions/prompts.ts";
import {
	type Questionnaire,
	SINGLE_QUESTION,
	shapeFor,
	validateQuestionnaire,
} from "../interactions/questionnaire.ts";
import {
	answerText,
	lateAnswerText,
	lateQuestionnaireText,
	questionnaireText,
	restartingText,
	sequentialText,
} from "./extensions/ask-user-text.ts";

/**
 * Asks a questionnaire on `prompts` and returns the tool's result text. A set the core refuses
 * posts no card. One question without previews, and a surface without `questionnaire` or with
 * room for fewer questions, go through `ask`: one question exactly as before 0.20, several one
 * at a time, stopping at the first that does not come back answered. While the host stops
 * (`stopping`), no card is posted, and one left waiting is reported lost: open cards do not
 * survive the restart. With `yoloGraceMs`, the turn's conversation is in yolo mode: each card
 * holds the turn that long at most, and one left unanswered tells it to go on with its own best
 * choice instead of ending its turn; the restart still wins over that.
 */
export async function askQuestions(
	prompts: Prompts,
	asker: string,
	questionnaire: Questionnaire,
	owner: OwnerIdentity,
	signal: AbortSignal | undefined,
	stopping?: () => boolean,
	yoloGraceMs?: number,
): Promise<string> {
	const yolo = yoloGraceMs !== undefined;
	const grace = yolo ? { graceMs: yoloGraceMs } : {};
	const refused = validateQuestionnaire(questionnaire);
	if (refused !== undefined) return refused;
	if (stopping?.()) return restartingText(owner, false);
	const lost = (answer: unknown) =>
		answer === "pending" && stopping?.() === true;
	const title = messages().askTitle(asker);
	const n = questionnaire.questions.length;
	const support = prompts.asks;
	const previews = questionnaire.questions.some((q) =>
		q.options.some((o) => o.preview !== undefined),
	);
	if (
		prompts.questionnaire &&
		support &&
		support.questions >= n &&
		(n > 1 || (previews && support.previews))
	) {
		const answer = await prompts.questionnaire(
			title,
			shapeFor(questionnaire, support),
			signal,
			{
				...grace,
				late: (late) =>
					late.kind === "questionnaire"
						? n === 1
							? lateAnswerText(
									questionnaire.questions[0]?.question ?? "",
									late.answer.answers[0] ?? { choices: [] },
									late.by,
								)
							: lateQuestionnaireText(questionnaire, late.answer, late.by)
						: undefined,
			},
		);
		if (lost(answer)) return restartingText(owner, true);
		if (n === 1)
			return answerText(
				answer === "pending" || answer === "declined" || answer === undefined
					? answer
					: (answer.answers[0] ?? { choices: [] }),
				owner,
				yolo,
			);
		return questionnaireText(answer, questionnaire, owner, yolo);
	}
	const shaped = shapeFor(questionnaire, SINGLE_QUESTION);
	const answers: OwnerAnswer[] = [];
	for (const [i, question] of shaped.questions.entries()) {
		const text = questionnaire.questions[i]?.question ?? question.question;
		const answer = await prompts.ask(title, question, signal, {
			...grace,
			late: (late) =>
				late.kind === "question"
					? lateAnswerText(text, late.answer, late.by)
					: undefined,
		});
		if (lost(answer)) return restartingText(owner, true);
		if (n === 1) return answerText(answer, owner, yolo);
		if (answer === "pending" || answer === "declined" || answer === undefined)
			return sequentialText(
				questionnaire,
				answers,
				answer ?? "unanswered",
				owner,
				answerText(answer, owner, yolo),
			);
		answers.push(answer);
	}
	return sequentialText(questionnaire, answers, undefined, owner, "");
}
