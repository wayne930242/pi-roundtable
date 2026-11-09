import { LineError } from "./errors.ts";

/** The most references a subscriber may return for one message, and the longest one. */
export const MAX_REFS = 100;
const MAX_REF_CHARS = 512;

export const checkRef = (ref: unknown): string => {
	if (
		typeof ref !== "string" ||
		ref === "" ||
		ref.length > MAX_REF_CHARS ||
		ref.includes("\u0000")
	)
		throw new LineError(
			"bad_refs",
			`line: a ref is a non-empty string of at most ${MAX_REF_CHARS} characters`,
		);
	return ref;
};

export const tooManyRefs = (): LineError =>
	new LineError(
		"bad_refs",
		`line: a message may have at most ${MAX_REFS} refs`,
	);

/**
 * The references a subscriber answered, checked: strings that PostgreSQL can store, once each, in
 * order. Nothing is a message with no references to add; anything else than `{ refs }` is refused,
 * so an answer meant as something else (a retry request, say) is not taken for a mirror.
 */
export function cleanRefs(answer: unknown): string[] {
	if (answer === undefined) return [];
	if (typeof answer !== "object" || answer === null || !("refs" in answer))
		throw new LineError(
			"bad_refs",
			"line: a subscriber answers a message with { refs } or nothing; to give up, throw",
		);
	const refs: unknown = answer.refs;
	if (!Array.isArray(refs) || refs.length > MAX_REFS) throw tooManyRefs();
	return [...new Set(refs.map(checkRef))];
}
