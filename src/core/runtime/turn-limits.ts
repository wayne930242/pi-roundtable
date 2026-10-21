import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { TurnResult } from "../domain/conversation.ts";
import { AgentRunError } from "../domain/errors.ts";
import { type TurnTimeout, TurnTimeoutError } from "../domain/turn-timeout.ts";
import { catalogFor } from "../i18n/index.ts";
import type { ChannelKey } from "../sessions.ts";
import type { PromptSlot } from "./prompt-slot.ts";
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

/** The time limit of a turn of the built-in runtime; see `runtimeTurnBudget`. `abort` aborts the turn. */
export function turnLimits(
	options: Parameters<typeof runtimeTurnBudget>[0],
	slot: Pick<PromptSlot, "waitedMs" | "cards">,
	channel: ChannelKey,
	abort: () => void,
): TurnLimits {
	const activity = activityTracker();
	let timedOut: TurnTimeout | undefined;
	const budget = runtimeTurnBudget(
		options,
		slot,
		channel,
		(timeout) => {
			timedOut = timeout;
			abort();
		},
		{ activity },
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
