import type { Judge } from "../contract/providers.ts";
import type { Logger } from "../log.ts";
import type { ThinkingLevel } from "../models.ts";

/** The levels the judge chooses between, lowest first; criterion i of a brief asks for level i. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh";
const EFFORT_LEVELS: readonly EffortLevel[] = [
	"low",
	"medium",
	"high",
	"xhigh",
];

/** What the judge is told about the conversation, and one criterion per effort level. */
export interface EffortBrief {
	instructions: string;
	criteria: readonly [string, string, string, string];
}

export const JUDGE_WORK =
	"How much step-by-step reasoning does handling the message well require? Judge the work " +
	"the message asks for, not its length or tone.";

/** The default brief: an assistant agent that works through tools for its owner. */
export const AGENT_BRIEF: EffortBrief = {
	instructions:
		"The owner sent this message to a personal assistant agent that works through tools: " +
		"notes, schedules, research, coding, and infrastructure. previous_reply, when present, is " +
		`the assistant's last answer in this conversation. ${JUDGE_WORK} A short reply that ` +
		"continues earlier work asks for as much as the work it continues.",
	criteria: [
		"Chat or a quick lookup: a greeting, thanks, a short factual question, reading one note " +
			"or calendar entry, setting a simple reminder, confirming or declining held actions.",
		"Routine work: a few tool calls in a row, a small edit or a message draft, summarizing a " +
			"page or a few notes, a research question with a clear answer.",
		"Substantial work: debugging, planning or changing code or infrastructure, research that " +
			"compares sources, a decision with real tradeoffs, work spanning several tools or systems.",
		"An exceptional problem that sustained reasoning would still get wrong: architecture or " +
			"migration across systems, a subtle correctness or security problem, synthesizing a " +
			"large body of material into a design, or the owner explicitly asks for the deepest " +
			"thinking available.",
	],
};

/**
 * How much of the distribution must reach each level before a first turn runs at it. The
 * top level is slow and costly, so it takes a near-certain answer; below it, half is enough.
 */
const REQUIRED_MASS = [0, 0.5, 0.5, 0.8] as const;

/** The judge reads this much of the previous reply; its gist is at the start and the end. */
const PREVIOUS_REPLY_CHARS = 1_500;

export interface EffortJudgeOptions<Fallback extends ThinkingLevel> {
	judge: Judge;
	brief: EffortBrief;
	/** The level of a first turn the judge could not judge. */
	fallback: Fallback;
	/** The share of the judge's answer a turn needs to move off the previous turn's level. */
	threshold: number;
	logger: Logger;
}

/** What the conversation's previous turn left: its answer and the level it ran at. */
export interface PreviousTurn<Level extends ThinkingLevel> {
	reply?: string;
	level?: Level;
}

/** Picks the thinking level of one turn from a message and what the previous turn left. */
export interface EffortPicker<Fallback extends ThinkingLevel = ThinkingLevel> {
	judge(
		message: string,
		previous?: PreviousTurn<EffortLevel | Fallback>,
	): Promise<EffortLevel | Fallback>;
}

/** The judge of a conversation's turns, reading each message against the brief. */
export function effortJudge<Fallback extends ThinkingLevel>(
	options: EffortJudgeOptions<Fallback>,
): EffortPicker<Fallback> {
	return new EffortJudge(options);
}

/** Picks the thinking level of one turn from the judge's reading of its message. */
export class EffortJudge<Fallback extends ThinkingLevel = ThinkingLevel>
	implements EffortPicker<Fallback>
{
	readonly #options: EffortJudgeOptions<Fallback>;

	constructor(options: EffortJudgeOptions<Fallback>) {
		this.#options = options;
	}

	/** Keeps the previous turn's level when the judge is unsure or fails. */
	async judge(
		message: string,
		previous: PreviousTurn<EffortLevel | Fallback> = {},
	): Promise<EffortLevel | Fallback> {
		const { judge, brief, fallback, threshold, logger } = this.#options;
		try {
			const probabilities = await judge.askScore(
				{
					message,
					...(previous.reply
						? { previous_reply: excerpt(previous.reply) }
						: {}),
				},
				"effort",
				{
					type: "score",
					instructions: brief.instructions,
					criteria: brief.criteria,
				},
			);
			const from = EFFORT_LEVELS.indexOf(previous.level as EffortLevel);
			const index =
				from === -1
					? levelIndex(probabilities)
					: moveIndex(from, probabilities, threshold);
			const level =
				index === from && previous.level
					? previous.level
					: (EFFORT_LEVELS[index] ?? "low");
			logger.info(
				{ probabilities, previous: previous.level, level },
				"effort decided",
			);
			return level;
		} catch (error) {
			const level = previous.level ?? fallback;
			logger.warn({ err: error, level }, "effort request failed");
			return level;
		}
	}
}

/**
 * A first turn's level: the highest level whose share of the distribution at or above it
 * meets REQUIRED_MASS. Below the top level that is the median of an ordinal answer, which
 * unlike the mean never lands on a middle level nothing voted for.
 */
export function levelIndex(probabilities: readonly number[]): number {
	let reached = 0;
	for (let index = probabilities.length - 1; index > 0; index--) {
		reached += probabilities[index] ?? 0;
		if (reached >= (REQUIRED_MASS[index] ?? 0.5)) return index;
	}
	return 0;
}

/**
 * A later turn's level, starting from the previous one: up to the highest level that
 * `threshold` of the answer reaches, and never less than a first turn needs, else down to
 * the lowest level that `threshold` of it stays at or under, else where it was. Upgrades
 * are checked first, because thinking too much costs less than answering wrong.
 */
export function moveIndex(
	from: number,
	probabilities: readonly number[],
	threshold: number,
): number {
	const sum = (values: readonly number[]) =>
		values.reduce((total, value) => total + value, 0);
	for (let index = probabilities.length - 1; index > from; index--)
		if (
			sum(probabilities.slice(index)) >=
			Math.max(threshold, REQUIRED_MASS[index] ?? 0)
		)
			return index;
	for (let index = 0; index < from; index++)
		if (sum(probabilities.slice(0, index + 1)) >= threshold) return index;
	return from;
}

function excerpt(text: string): string {
	if (text.length <= PREVIOUS_REPLY_CHARS) return text;
	const half = PREVIOUS_REPLY_CHARS / 2;
	return `${text.slice(0, half)}\n…\n${text.slice(-half)}`;
}
