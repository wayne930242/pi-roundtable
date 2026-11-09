import type {
	Approval,
	ApprovalDetails,
	AskSupport,
	OwnerQuestion,
} from "pi-roundtable";
import {
	APPROVAL_MAX_BYTES,
	type PromptFrame,
	type PromptOutcome,
} from "./protocol.ts";

export type ApprovalFrame = NonNullable<
	Extract<PromptFrame, { kind: "approval" }>["approval"]
>;

/**
 * The approval as the frame carries it: whole while its JSON is within `APPROVAL_MAX_BYTES`.
 * Over that, each string value of the input is cut to the most code points that fit, marked
 * `… [N chars]`, and `truncated` is set; an input that does not fit even then is sent as `{}`
 * with no files. The copy text is only informational, so it is carried after the input is
 * settled and only if it fits then, never at the input's cost. The card's `message` text always
 * accompanies it.
 */
export function boundedApproval(details: ApprovalDetails): ApprovalFrame {
	const size = (value: unknown) =>
		new TextEncoder().encode(JSON.stringify(value)).length;
	if (size(details) <= APPROVAL_MAX_BYTES) return details;
	const { copy, ...withoutCopy } = details;
	const bounded = boundedWithoutCopy(withoutCopy, size);
	if (!copy) return bounded;
	const candidate: ApprovalFrame = { ...bounded, copy };
	return size(candidate) <= APPROVAL_MAX_BYTES ? candidate : bounded;
}

/** `boundedApproval` for details without a copy text. */
export function boundedWithoutCopy(
	details: Omit<ApprovalDetails, "copy">,
	size: (value: unknown) => number,
): ApprovalFrame {
	if (size(details) <= APPROVAL_MAX_BYTES) return details;
	const { files: _files, ...base } = details;
	const fits = (limit: number): ApprovalFrame | undefined => {
		const candidate: ApprovalFrame = {
			...base,
			input: cutStrings(details.input, limit) as Record<string, unknown>,
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

/** Code points in `text`. */
const pointsOf = (text: string) => Array.from(text).length;

/** The longest string anywhere in `value`, in code points. */
// pi-lens-ignore: no-unknown-parameters — tool input is untyped model JSON; this is where it is read
export function longestString(value: unknown): number {
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

/** `value` with each string longer than `limit` code points cut to its start plus `… [N chars]`. */
// pi-lens-ignore: no-unknown-parameters — tool input is untyped model JSON; this is where it is read
export function cutStrings(value: unknown, limit: number): unknown {
	if (typeof value === "string") {
		if (value.length <= limit) return value;
		const points = Array.from(value);
		if (points.length <= limit) return value;
		return `${points.slice(0, limit).join("")}… [${points.length} chars]`;
	}
	if (Array.isArray(value))
		return value.map((v: unknown) => cutStrings(v, limit));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([k, v]) => [k, cutStrings(v, limit)]),
		);
	return value;
}

export function toApproval(outcome: PromptOutcome): Approval {
	if (outcome === "approved" || outcome === "declined") return outcome;
	// A withdrawal is read as the turn's wait ending; the gate knows it was withdrawn.
	return outcome === "cancelled" || outcome === "withdrawn"
		? "cancelled"
		: "expired";
}

export function questionFrame(
	id: string,
	title: string,
	question: OwnerQuestion,
): PromptFrame {
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

/**
 * Whether a connection with `support` may be sent the prompt: every prompt but a questionnaire,
 * which only a connection that declared support covering its questions and previews may have.
 */
export function showable(
	frame: PromptFrame,
	support: AskSupport | undefined,
): boolean {
	if (frame.kind !== "questionnaire") return true;
	if (!support) return false;
	if (frame.questions.length > support.questions) return false;
	const previews = frame.questions.some((q) =>
		q.options.some((o) => o.preview),
	);
	return support.previews || !previews;
}
