import type { ChannelKey } from "../sessions.ts";
import type { PromptSlot } from "./prompt-slot.ts";
import type { PiAgentRuntimeOptions } from "./runtime-types.ts";

/** Which limit ended a turn: its budget since the start or the last steer, or its cap. */
export type TurnLimit = "turn" | "turnMax";

/** A turn's time limit, which a steered message renews up to a cap on the whole turn. */
export interface TurnBudget {
	/**
	 * Gives the turn its full budget again from now, up to the cap; the work time left, in ms,
	 * or undefined when the cap is reached and the turn takes no more steering.
	 */
	renew(): number | undefined;
	/** Whether the turn has worked up to its cap. */
	capped(): boolean;
	cancel(): void;
}

/** The clock a turn budget reads; the real one by default, a fake one in tests. */
export interface BudgetClock {
	now(): number;
	schedule(run: () => void, ms: number): () => void;
}

const REAL_CLOCK: BudgetClock = {
	now: () => Date.now(),
	schedule: (run, ms) => {
		const timer = setTimeout(run, ms);
		return () => clearTimeout(timer);
	},
};

/**
 * The shortest wait before a budget looks again at a turn that still has time. While a card is
 * open the turn's work time stands still, so a timer that fires with a few milliseconds left would
 * otherwise re-arm for those milliseconds, again and again, for as long as the card waits. The
 * floor bounds that to one look a second; the cost is that a limit may fire up to this much late,
 * when the card closes just before it.
 */
const REARM_FLOOR_MS = 1_000;

/**
 * Calls `expire` once the turn has worked `ms` since it started or since its last renewal, or
 * `maxMs` in all, whichever comes first; time the slot spent waiting on the owner's cards counts
 * towards neither. `expire` is told which limit fired.
 */
export function turnBudget(
	ms: number,
	maxMs: number,
	slot: Pick<PromptSlot, "waitedMs">,
	expire: (limit: TurnLimit) => void,
	clock: BudgetClock = REAL_CLOCK,
): TurnBudget {
	const started = clock.now();
	const worked = () => {
		const now = clock.now();
		return now - started - slot.waitedMs(now);
	};
	let deadline = Math.min(ms, maxMs);
	let cancelTimer: (() => void) | undefined;
	let expired = false;
	const arm = (delay: number) => {
		cancelTimer = clock.schedule(() => {
			const left = deadline - worked();
			if (left > 0) return arm(Math.max(left, REARM_FLOOR_MS));
			expired = true;
			expire(deadline >= maxMs ? "turnMax" : "turn");
		}, delay);
	};
	arm(deadline);
	return {
		renew() {
			const now = worked();
			if (expired || now >= maxMs) return undefined;
			deadline = Math.min(now + ms, maxMs);
			cancelTimer?.();
			arm(deadline - now);
			return deadline - now;
		},
		capped: () => expired || worked() >= maxMs,
		cancel: () => cancelTimer?.(),
	};
}

/**
 * The time limit of one turn of the built-in runtime, from its options: `turnTimeoutMs` (default
 * 10 minutes) renewed by each steer up to `turnMaxMs` (default three times that). It logs each
 * renewal and, when a limit fires, which one before it calls `abort`.
 */
export function runtimeTurnBudget(
	options: Pick<
		PiAgentRuntimeOptions,
		"turnTimeoutMs" | "turnMaxMs" | "logger"
	>,
	slot: Pick<PromptSlot, "waitedMs">,
	channel: ChannelKey,
	abort: () => void,
): TurnBudget {
	const { logger, turnTimeoutMs = 10 * 60_000 } = options;
	const turnMaxMs = options.turnMaxMs ?? 3 * turnTimeoutMs;
	const budget = turnBudget(turnTimeoutMs, turnMaxMs, slot, (limit) => {
		logger.warn(
			{ channel, limit, turnTimeoutMs, turnMaxMs },
			"turn timed out; aborting",
		);
		abort();
	});
	return {
		...budget,
		renew() {
			const deadlineMs = budget.renew();
			if (deadlineMs !== undefined)
				logger.info(
					{ channel, deadlineMs },
					"steer renewed the turn's time budget",
				);
			return deadlineMs;
		},
	};
}
