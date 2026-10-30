import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { TurnResult } from "../domain/conversation.ts";
import { AgentRunError } from "../domain/errors.ts";
import { type TurnTimeout, TurnTimeoutError } from "../domain/turn-timeout.ts";
import { catalogFor } from "../i18n/index.ts";
import { DEFAULT_AUTONOMY } from "../modes/autonomy.ts";
import type { ChannelKey } from "../sessions.ts";
import type { PromptSlot } from "./prompt-slot.ts";
import type { PiAgentRuntimeOptions } from "./runtime-types.ts";
import { activityTracker } from "./turn-activity.ts";
import { runtimeTurnBudget, type TurnBudget } from "./turn-budget.ts";

/** One turn's time limit, with what it follows of the turn to say why it fired. */
export interface TurnLimits {
	budget: TurnBudget;
	/** Follows the turn's events: its tools and its compactions. */
	observe(event: AgentSessionEvent): void;
	/** The turn's failure when a limit aborted it, its reason as a `TurnTimeoutError`; else undefined. */
	failure(): TurnResult | undefined;
}

/** The answer to a turn whose prompt threw, when no limit aborted it. */
export function promptFailed(error: unknown): TurnResult {
	return {
		ok: false,
		error: new AgentRunError(`prompt failed: ${String(error)}`),
	};
}

/** A timed-out turn's reason in English, for its error and the logs. */
export function timeoutMessage(timeout: TurnTimeout): string {
	return catalogFor("en").turnTimedOutNotice(timeout);
}

/**
 * The time limit of a turn of the built-in runtime; see `runtimeTurnBudget`. `abort` aborts the
 * turn. In a long-running conversation (`options.modes`) a limit extends the turn instead of
 * asking or aborting, until the turn has worked `options.autonomy.longRunningMaxMs`. A
 * `timeLimitMs` replaces the turn's limit and its cap, both held under that same ceiling.
 */
export function turnLimits(
	options: Parameters<typeof runtimeTurnBudget>[0] &
		Pick<PiAgentRuntimeOptions, "modes" | "autonomy">,
	slot: Pick<PromptSlot, "waitedMs" | "cards">,
	channel: ChannelKey,
	abort: () => void,
	timeLimitMs?: number,
): TurnLimits {
	const { longRunningMaxMs } = options.autonomy ?? DEFAULT_AUTONOMY;
	const limited =
		timeLimitMs === undefined
			? options
			: {
					...options,
					turnTimeoutMs: Math.min(timeLimitMs, longRunningMaxMs),
					turnMaxMs: Math.min(timeLimitMs, longRunningMaxMs),
				};
	const keepGoing = (workedMs: number) =>
		workedMs < longRunningMaxMs &&
		options.modes?.peek(channel).longRunning === true;
	const activity = activityTracker();
	let timedOut: TurnTimeout | undefined;
	const budget = runtimeTurnBudget(
		limited,
		slot,
		channel,
		(timeout) => {
			timedOut = timeout;
			abort();
		},
		{ activity, keepGoing, ceilingMs: longRunningMaxMs },
	);
	return {
		budget,
		observe: (event) => activity.observe(event),
		failure: () =>
			timedOut && {
				ok: false,
				error: new TurnTimeoutError(timedOut, timeoutMessage(timedOut)),
			},
	};
}
