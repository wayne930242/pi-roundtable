// A Judge over Jev's hosted service, built on pi-jev-compaction's client.

import { JevClient, type JevQuestions } from "pi-jev-compaction";
import type {
	ChoiceAnswer,
	ChoiceQuestion,
	Judge,
	ScoreQuestion,
	YesNoQuestion,
} from "../core/contract/providers.ts";
import { JudgeError } from "../core/errors.ts";

/** The service's name for the yes-or-no question and for its answer's probability. */
const WIRE_YES_NO = "noul";
type JevQuestion = JevQuestions[string];
const DEFAULT_TIMEOUT_MS = 20_000;

export interface JevJudgeOptions {
	/** The service's API key. It is required: an empty one is refused, not looked up in the environment. */
	apiKey: string;
	/** The service's model; default pi-jev-compaction's. */
	model?: string;
	/** The service's endpoint; default pi-jev-compaction's. */
	baseUrl?: string;
	/** How long one question may take, the read of the answer included; default 20,000. */
	timeoutMs?: number;
	/** The request function; default the global `fetch`. */
	fetch?: typeof fetch;
}

// pi-lens-ignore: no-unknown-parameters — a type guard over parsed JSON
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

// pi-lens-ignore: no-unknown-parameters — a type guard over parsed JSON
const isProbability = (value: unknown): value is number =>
	typeof value === "number" && value >= 0 && value <= 1;

/**
 * A `Judge` that asks Jev. Each question is one request with its own time limit of `timeoutMs`,
 * which also covers reading the answer. Every failure throws a `JudgeError`: a missing answer,
 * a probability outside 0 to 1, a choice that is not one of the listed options, a failed request,
 * and a limit that ran out. An empty `apiKey` is refused when the judge is made.
 */
export function jevJudge(options: JevJudgeOptions): Judge {
	const apiKey = options.apiKey.trim();
	if (!apiKey)
		throw new JudgeError(
			"jevJudge needs an apiKey; an empty one would fall back to the environment's key",
		);
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	async function ask(
		state: Record<string, unknown>,
		questions: JevQuestions,
	): Promise<Record<string, unknown>> {
		const signal = AbortSignal.timeout(timeoutMs);
		const client = new JevClient({
			apiKey,
			model: options.model,
			baseUrl: options.baseUrl,
			fetch: options.fetch,
			signal,
		});
		try {
			return (await client.ask(state, questions)).answers;
		} catch (error) {
			if (error instanceof JudgeError) throw error;
			if (signal.aborted)
				throw new JudgeError(`Jev did not answer within ${timeoutMs} ms`, {
					cause: error,
				});
			const message = error instanceof Error ? error.message : String(error);
			throw new JudgeError(
				/^Jev/.test(message) ? message : `Jev request failed: ${message}`,
				{ cause: error },
			);
		}
	}

	const malformed = (name: string, detail = "") =>
		new JudgeError(`Jev's answer for ${name} is malformed${detail}`);

	return {
		async askYesNo(
			state: Record<string, unknown>,
			questions: Record<string, YesNoQuestion>,
		): Promise<Record<string, number>> {
			const names = Object.keys(questions);
			if (names.length === 0) return {};
			const answers = await ask(
				state,
				Object.fromEntries(
					names.map((name) => {
						const { type: _type, ...question } = questions[
							name
						] as YesNoQuestion;
						return [name, { ...question, type: WIRE_YES_NO } as JevQuestion];
					}),
				),
			);
			// pi-lens-ignore: no-known-value-widening — filled per question name below
			const result: Record<string, number> = {};
			for (const name of names) {
				const answer = answers[name];
				const probability = isRecord(answer) ? answer[WIRE_YES_NO] : undefined;
				if (!isProbability(probability)) throw malformed(name);
				result[name] = probability;
			}
			return result;
		},

		async askChoice(
			state: Record<string, unknown>,
			name: string,
			question: ChoiceQuestion,
		): Promise<ChoiceAnswer> {
			const answer = (await ask(state, { [name]: question }))[name];
			if (
				!isRecord(answer) ||
				typeof answer.choice !== "string" ||
				!isProbability(answer.confidence)
			)
				throw malformed(name);
			if (!Object.hasOwn(question.criteria, answer.choice))
				throw new JudgeError(
					`Jev chose ${answer.choice}, which is not an option of ${name}`,
				);
			return { choice: answer.choice, confidence: answer.confidence };
		},

		async askScore(
			state: Record<string, unknown>,
			name: string,
			question: ScoreQuestion,
		): Promise<number[]> {
			if (question.criteria.length === 0) return [];
			const answer = (
				await ask(state, {
					[name]: { ...question, criteria: [...question.criteria] },
				})
			)[name];
			const probabilities = isRecord(answer) ? answer.probabilities : undefined;
			if (!isRecord(probabilities)) throw malformed(name);
			return question.criteria.map((_, index) => {
				const value = probabilities[String(index)];
				if (!isProbability(value))
					throw malformed(name, `: no probability for criterion ${index}`);
				return value;
			});
		},
	};
}
