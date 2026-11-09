import type { ApprovedBy, PromptWait } from "pi-roundtable";
import type { CardAnswer, PromptOutcome } from "../api-types.ts";

import type { Answerer, Ended } from "./desk-types.ts";

/** What a card tells a turn that may stop waiting, and how long it waits first; nothing without a `wait`. */
export function pendingOf(wait: PromptWait | undefined): {
	pending?: "pending";
	graceMs?: number;
} {
	if (!wait) return {};
	return {
		pending: "pending",
		...(wait.graceMs === undefined ? {} : { graceMs: wait.graceMs }),
	};
}

export const outcomeOf = (ended: Ended): PromptOutcome => {
	if (ended.type === "approval")
		return ended.approved ? "approved" : "declined";
	return ended.type === "cancel" ? "declined" : "answered";
};

/** What a question card was answered, in the shape the history keeps. */
export function answerOf(ended: Ended): CardAnswer | undefined {
	if (ended.type === "answer") return { kind: "ask", answer: ended.answer };
	if (ended.type === "answers")
		return {
			kind: "questionnaire",
			answers: ended.answer.answers.map((one) => one ?? null),
			...(ended.answer.note ? { note: ended.answer.note } : {}),
		};
	return undefined;
}

export function approvedBy(by: Answerer): ApprovedBy {
	return {
		principalId: by.principalId,
		speakerId: by.speakerId,
		name: by.name,
		...(by.tier === "owner" ? { owner: true as const } : {}),
	};
}
