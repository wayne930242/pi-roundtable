import type {
	ApprovalDetails,
	ApprovalWording,
	OwnerQuestion,
	Questionnaire,
} from "pi-roundtable";
import {
	APPROVAL_MAX_BYTES,
	type PromptApproval,
	type PromptFrame,
} from "../api-types.ts";

/**
 * The approval as the frame carries it: whole while its JSON is within `APPROVAL_MAX_BYTES`.
 * Over that, each string value of the input is cut to the most code points that fit, marked
 * `… [N chars]`, and `truncated` is set; an input that does not fit even then is sent as `{}`
 * with no files. The copy text is informational, so it is carried after the input is settled
 * and only if it fits then, never at the input's cost. The card's `message` always accompanies it.
 */
export function boundedApproval(details: ApprovalDetails): PromptApproval {
	const size = (value: unknown) =>
		new TextEncoder().encode(JSON.stringify(value)).length;
	if (size(details) <= APPROVAL_MAX_BYTES) return details;
	const { copy, ...withoutCopy } = details;
	const bounded = boundedWithoutCopy(withoutCopy, size);
	if (!copy) return bounded;
	const candidate: PromptApproval = { ...bounded, copy };
	return size(candidate) <= APPROVAL_MAX_BYTES ? candidate : bounded;
}

function boundedWithoutCopy(
	details: Omit<ApprovalDetails, "copy">,
	size: (value: unknown) => number,
): PromptApproval {
	if (size(details) <= APPROVAL_MAX_BYTES) return details;
	const { files: _files, ...base } = details;
	const fits = (limit: number): PromptApproval | undefined => {
		const candidate: PromptApproval = {
			...base,
			input: cutStrings(details.input, limit),
			truncated: true,
		};
		return size(candidate) <= APPROVAL_MAX_BYTES ? candidate : undefined;
	};
	let low = 0;
	let high = longestString(details.input);
	let best = fits(0);
	if (!best) return { ...base, input: {}, truncated: true };
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		const candidate = fits(mid);
		if (candidate) {
			best = candidate;
			low = mid;
		} else high = mid - 1;
	}
	return best;
}

const pointsOf = (text: string) => Array.from(text).length;

// pi-lens-ignore: no-unknown-parameters — tool input is untyped model JSON; this is where it is read
function longestString(value: unknown): number {
	if (typeof value === "string") return pointsOf(value);
	if (Array.isArray(value))
		return Math.max(0, ...value.map((v: unknown) => longestString(v)));
	if (value && typeof value === "object")
		return Math.max(
			0,
			...Object.values(value).map((v: unknown) => longestString(v)),
		);
	return 0;
}

/** `value` with every string longer than `limit` code points cut to its start plus `… [N chars]`. */
function cutStrings<T>(value: T, limit: number): T {
	if (typeof value === "string") {
		if (value.length <= limit) return value;
		const points = Array.from(value);
		if (points.length <= limit) return value;
		return `${points.slice(0, limit).join("")}… [${points.length} chars]` as T;
	}
	if (Array.isArray(value))
		return value.map((v: unknown) => cutStrings(v, limit)) as T;
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([k, v]) => [k, cutStrings(v, limit)]),
		) as T;
	return value;
}

/** An `ask` card's frame, from the core's question. */
export function askFrame(
	id: string,
	title: string,
	question: OwnerQuestion,
): Extract<PromptFrame, { kind: "ask" }> {
	return {
		id,
		kind: "ask",
		title,
		question: question.question,
		options: question.options.map((option) => ({ ...option })),
		multi: question.multi,
		allowOther: question.allowOther,
	};
}

/** A `questionnaire` card's frame, the core's questions copied verbatim. */
export function questionnaireFrame(
	id: string,
	title: string,
	questionnaire: Questionnaire,
): Extract<PromptFrame, { kind: "questionnaire" }> {
	return {
		id,
		kind: "questionnaire",
		title,
		questions: questionnaire.questions.map((q) => ({
			...q,
			options: q.options.map((option) => ({ ...option })),
		})),
	};
}

/** The card's own words, copied so a later change of the caller's object cannot reach the frame. */
export function wordingFrame(
	wording: ApprovalWording,
): NonNullable<Extract<PromptFrame, { kind: "approval" }>["wording"]> {
	const { approve, decline, footer, approved, declined } = wording;
	return { approve, decline, footer, approved, declined };
}
