import { AgentRunError } from "./errors.ts";

/** Which limit a turn reached: its budget since the start or the last steer, or its cap. */
export type TurnLimit = "turn" | "turnMax";

/**
 * How a timed-out turn ended: at its limit with no card to ask on (`timeout`), cancelled on the
 * timeout card (`cancelled`), or with the card unanswered in its grace period (`unanswered`).
 */
export type TurnTimeoutEnd = "timeout" | "cancelled" | "unanswered";

/** Why a turn hit a time limit, as data: which limit, how long it worked, and what it was doing. */
export interface TurnTimeout {
	limit: TurnLimit;
	/** The limit's length: the budget, or the cap as the owner's Continues raised it. */
	limitMs: number;
	/** The turn's work so far, not counting time spent waiting on the owner's other cards. */
	workedMs: number;
	/** The tools running, the longest-running first, each with how long it has run. */
	running: { tool: string; ms: number }[];
	compacting: boolean;
	/** Every tool called so far, by name, with how often. */
	tools: [string, number][];
	/** How long the timeout card waits for an answer. */
	graceMs: number;
	end: TurnTimeoutEnd;
	/** No timeout card could be shown, as in a schedule's turn, so nobody was asked whether to go on. */
	unasked?: true;
}

/** A turn aborted at a time limit; `timeout` says why, and the message says it in English. */
export class TurnTimeoutError extends AgentRunError {
	override name = "TurnTimeoutError";
	constructor(
		readonly timeout: TurnTimeout,
		message: string,
	) {
		super(message);
	}
}
