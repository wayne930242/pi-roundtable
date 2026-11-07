import { decodedJson as decoded } from "../../shared/json-arguments.ts";

/**
 * The arguments of an `ask_user` call in the `questions` form: a legacy call's top-level
 * `{ question, options, multi, allow_other }` becomes one question (its `allow_other` stays false
 * unless set, as before 0.20), and a `questions` or `options` value that arrived as a JSON string
 * is decoded. Anything else is left for the schema to refuse.
 */
// pi-lens-ignore: no-unknown-returns — pi checks the folded arguments against the tool schema right after
export function foldAskArguments(args: unknown): unknown {
	if (typeof args !== "object" || args === null || Array.isArray(args))
		return args;
	const input = args as Record<string, unknown>;
	if (input.questions !== undefined && input.question !== undefined)
		throw new Error(
			"Use either `questions` or the old top-level `question`, not both.",
		);
	if (input.questions === undefined && typeof input.question === "string") {
		const { question, options, multi, allow_other, ...rest } = input;
		return {
			...rest,
			questions: [
				{
					question,
					...(options !== undefined ? { options: decoded(options) } : {}),
					...(multi !== undefined ? { multi } : {}),
					allow_other: allow_other ?? false,
				},
			],
		};
	}
	const questions = decoded(input.questions);
	if (!Array.isArray(questions)) return { ...input, questions };
	return {
		...input,
		questions: questions.map((item: unknown) => {
			const q = decoded(item);
			return typeof q === "object" && q !== null && "options" in q
				? { ...q, options: decoded((q as { options: unknown }).options) }
				: q;
		}),
	};
}
