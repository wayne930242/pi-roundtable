import { ConfigError } from "../domain/errors.ts";
import { type Autonomy, DEFAULT_LONG_RUNNING_MS } from "../modes/autonomy.ts";
import { integer, list, optional, shape, text } from "./schema.ts";

/** The configuration's `turnLimits` and `autonomy`: how long a turn works, and what runs without a person. */
export interface LimitsConfig {
	/**
	 * How long one turn may work before it asks the owner on a card whether to go on, or is
	 * stopped when it cannot show a card. Time spent waiting on the owner's cards does not count.
	 */
	turnLimits?: {
		/** The budget of a turn, renewed by each message steered into it; 60 to 86400, default 600 (10 min). */
		timeoutSeconds?: number;
		/** The most one turn works in all, however often it is steered; at least `timeoutSeconds`, default three times it. */
		maxSeconds?: number;
		/** How long the card that asks whether to go on waits for an answer, in wall time; 30 to 3600, default 300. */
		cardSeconds?: number;
	};
	/** What a conversation may do without a person, once its owner switches the mode on. */
	autonomy?: {
		/** Yolo mode: the server approves held calls instead of asking, within these limits. */
		yolo?: {
			/**
			 * Hold classes yolo approves although it cards them by default, such as `shell.rm`, and the
			 * names of rules that report no classes, such as `tool:repo_push`, whose calls it then approves.
			 */
			allow?: readonly string[];
			/** Hold classes or rule names yolo never approves, such as `shell.push` or `tool:repo_push`. */
			card?: readonly string[];
		};
		/** Long-running mode: a turn that reaches its time limit goes on by itself, up to this. */
		longRunning?: {
			/** The most one turn works in all before it asks or stops; 600 to 604800, default 14400 (4 h). */
			maxSeconds?: number;
		};
	};
}

/** The two keys' shapes, spread into the configuration's. */
export const limitsShape = {
	turnLimits: optional(
		shape({
			timeoutSeconds: optional(integer(60, 86_400)),
			maxSeconds: optional(integer(60, 604_800)),
			cardSeconds: optional(integer(30, 3_600)),
		}),
	),
	autonomy: optional(
		shape({
			yolo: optional(
				shape({ allow: optional(list(text)), card: optional(list(text)) }),
			),
			longRunning: optional(
				shape({ maxSeconds: optional(integer(600, 604_800)) }),
			),
		}),
	),
};

/** The limits with their defaults, in ms; `maxMs` is never below `timeoutMs`. */
export interface ResolvedLimits {
	turnLimits: { timeoutMs: number; maxMs: number; cardMs: number };
	autonomy: Autonomy;
}

/** The configuration's limits with every default filled, refusing a cap below the timeout. */
export function limitsOf(config: LimitsConfig): ResolvedLimits {
	const { turnLimits, autonomy } = config;
	const timeoutSeconds = turnLimits?.timeoutSeconds ?? 600;
	const maxSeconds = turnLimits?.maxSeconds ?? 3 * timeoutSeconds;
	if (maxSeconds < timeoutSeconds)
		throw new ConfigError(
			`config turnLimits.maxSeconds: expected at least turnLimits.timeoutSeconds (${timeoutSeconds}), got ${maxSeconds}. Raise maxSeconds, or lower timeoutSeconds.`,
		);
	const longRunning = autonomy?.longRunning?.maxSeconds;
	return {
		turnLimits: {
			timeoutMs: timeoutSeconds * 1_000,
			maxMs: maxSeconds * 1_000,
			cardMs: (turnLimits?.cardSeconds ?? 300) * 1_000,
		},
		autonomy: {
			yolo: {
				allow: autonomy?.yolo?.allow ?? [],
				card: autonomy?.yolo?.card ?? [],
			},
			longRunningMaxMs:
				longRunning === undefined
					? DEFAULT_LONG_RUNNING_MS
					: longRunning * 1_000,
		},
	};
}
