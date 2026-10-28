import type {
	TurnLimit,
	TurnTimeout,
	TurnTimeoutEnd,
} from "../domain/turn-timeout.ts";
import { messages } from "../i18n/index.ts";
import type { Approval } from "../interactions/prompts.ts";
import type { ChannelKey } from "../sessions.ts";
import type { PromptSlot } from "./prompt-slot.ts";
import type { PiAgentRuntimeOptions } from "./runtime-types.ts";
import type { ActivityTracker } from "./turn-activity.ts";

export type { TurnLimit };

/** A turn's time limit, which a steered message renews up to a cap on the whole turn. */
export interface TurnBudget {
	/**
	 * Gives the turn its full budget again from now, up to the cap; the work time left, in ms,
	 * or undefined when the cap is reached and the turn takes no more steering.
	 */
	renew(): number | undefined;
	/**
	 * After a limit fired, gives the turn its full budget again from now, as the owner's Continue
	 * does; with `raiseCap` the cap moves too, to a full budget from now. With `ceilingMs`
	 * the limit never lands past that much work: a turn that reaches it fires there, as at its cap,
	 * whatever is left of its budget. A later `extend` without one lifts the ceiling.
	 */
	extend(raiseCap: boolean, ceilingMs?: number): void;
	/** Whether the turn has worked up to its cap, or a limit fired and was not extended. */
	capped(): boolean;
	/** The turn's work so far, not counting time the slot spent waiting on cards. */
	workedMs(): number;
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
 * floor bounds that to one look a second; the cost is that a limit that waiting on a card pushed
 * back, by less than the floor, may fire up to this much late.
 */
const REARM_FLOOR_MS = 1_000;

/**
 * Calls `expire` once the turn has worked `ms` since it started or since its last renewal, or
 * `maxMs` in all, whichever comes first; time the slot spent waiting on the owner's cards counts
 * towards neither. `expire` is told which limit fired and its length.
 */
export function turnBudget(
	ms: number,
	maxMs: number,
	slot: Pick<PromptSlot, "waitedMs">,
	expire: (limit: TurnLimit, limitMs: number) => void,
	clock: BudgetClock = REAL_CLOCK,
): TurnBudget {
	const started = clock.now();
	const worked = () => {
		const now = clock.now();
		return now - started - slot.waitedMs(now);
	};
	let cap = maxMs;
	// The work time an extension was told not to pass; none until one is.
	let ceiling = Number.POSITIVE_INFINITY;
	let deadline = Math.min(ms, cap);
	let cancelTimer: (() => void) | undefined;
	let expired = false;
	const arm = (delay: number) => {
		cancelTimer = clock.schedule(() => {
			const left = deadline - worked();
			if (left > 0) return arm(Math.max(left, REARM_FLOOR_MS));
			expired = true;
			if (deadline >= cap) expire("turnMax", cap);
			else if (deadline >= ceiling) expire("turnMax", ceiling);
			else expire("turn", ms);
		}, delay);
	};
	arm(deadline);
	return {
		renew() {
			const now = worked();
			if (expired || now >= cap) return undefined;
			deadline = Math.min(now + ms, cap, ceiling);
			cancelTimer?.();
			arm(deadline - now);
			return deadline - now;
		},
		extend(raiseCap, ceilingMs) {
			const now = worked();
			if (raiseCap) cap = Math.max(cap, now + ms);
			ceiling = ceilingMs ?? Number.POSITIVE_INFINITY;
			deadline = Math.min(now + ms, cap, ceiling);
			expired = false;
			cancelTimer?.();
			arm(Math.max(deadline - now, REARM_FLOOR_MS));
		},
		capped: () => expired || worked() >= cap,
		workedMs: worked,
		cancel: () => cancelTimer?.(),
	};
}

/** What the runtime's turn budget needs besides its options: what the turn is doing, and its clock. */
export interface TurnBudgetSeams {
	activity: Pick<ActivityTracker, "now">;
	clock?: BudgetClock;
	/**
	 * Asked when a limit fires, with the turn's work so far: true goes on without a card, as the
	 * owner's Continue would (a long-running conversation, up to its own cap); false takes the
	 * limit's usual path, a card or an abort. It also answers for a turn that cannot show a card.
	 */
	keepGoing?: (workedMs: number) => boolean;
	/**
	 * The work time, in ms, a `keepGoing` extension never carries the turn past: the limit then
	 * fires at it, as the turn's cap, so a long time limit cannot overshoot the long-running cap.
	 */
	ceilingMs?: number;
}

/**
 * The time limit of one turn of the built-in runtime, from its options: `turnTimeoutMs` (default
 * 10 minutes) renewed by each steer up to `turnMaxMs` (default three times that). When a limit
 * fires on a turn that can show the owner a card, the turn keeps working and a card asks whether
 * to go on: Continue extends the limit that fired by a full budget from then, Cancel aborts, and
 * no answer within `turnTimeoutCardMs` (default 5 minutes, wall time) aborts. The card closes
 * when the turn ends first. Without a card the turn is aborted at once. `abort` is told why.
 * When `seams.keepGoing` says so, the limit is extended server-side first and neither happens.
 */
export function runtimeTurnBudget(
	options: Pick<
		PiAgentRuntimeOptions,
		"turnTimeoutMs" | "turnMaxMs" | "turnTimeoutCardMs" | "logger"
	>,
	slot: Pick<PromptSlot, "waitedMs" | "cards">,
	channel: ChannelKey,
	abort: (timeout: TurnTimeout) => void,
	seams: TurnBudgetSeams,
): TurnBudget {
	const { logger, turnTimeoutMs = 10 * 60_000 } = options;
	const turnMaxMs = options.turnMaxMs ?? 3 * turnTimeoutMs;
	const graceMs = options.turnTimeoutCardMs ?? 5 * 60_000;
	const clock = seams.clock ?? REAL_CLOCK;
	/** Closes the open timeout card, if any, with the footer given. */
	let closeCard: ((footer: string) => void) | undefined;
	const reason = (
		limit: TurnLimit,
		limitMs: number,
		end: TurnTimeoutEnd,
	): TurnTimeout => ({
		limit,
		limitMs,
		workedMs: budget.workedMs(),
		...seams.activity.now(clock.now()),
		graceMs,
		end,
	});
	const stop = (timeout: TurnTimeout) => {
		logger.warn(
			{
				channel,
				limit: timeout.limit,
				turnTimeoutMs,
				turnMaxMs,
				workedMs: timeout.workedMs,
				running: timeout.running,
				compacting: timeout.compacting,
				tools: timeout.tools,
				end: timeout.end,
			},
			"turn timed out; aborting",
		);
		abort(timeout);
	};
	const budget = turnBudget(
		turnTimeoutMs,
		turnMaxMs,
		slot,
		(limit, limitMs) => {
			if (seams.keepGoing?.(budget.workedMs())) {
				budget.extend(limit === "turnMax", seams.ceilingMs);
				logger.info(
					{ channel, limit, workedMs: budget.workedMs() },
					"long-running mode continued the turn",
				);
				return;
			}
			const prompts = slot.cards;
			if (!prompts) return stop(reason(limit, limitMs, "timeout"));
			const m = messages();
			const asked = reason(limit, limitMs, "timeout");
			logger.info(
				{
					channel,
					limit,
					workedMs: asked.workedMs,
					running: asked.running,
				},
				"turn reached its time limit; asking the owner",
			);
			const controller = new AbortController();
			let open = true;
			const settle = () => {
				if (!open) return false;
				open = false;
				closeCard = undefined;
				cancelGrace();
				return true;
			};
			const cancelGrace = clock.schedule(() => {
				if (!settle()) return;
				const timeout = reason(limit, limitMs, "unanswered");
				controller.abort(m.turnTimeoutUnanswered(timeout));
				stop(timeout);
			}, graceMs);
			closeCard = (footer) => {
				if (settle()) controller.abort(footer);
			};
			const answered = (approval: Approval) => {
				if (!settle()) return;
				if (approval === "approved") {
					budget.extend(limit === "turnMax");
					logger.info(
						{ channel, limit, workedMs: budget.workedMs() },
						"owner continued the turn past its time limit",
					);
				} else
					stop(
						reason(
							limit,
							limitMs,
							approval === "declined" ? "cancelled" : "timeout",
						),
					);
			};
			prompts
				.confirm(
					m.turnTimeoutTitle,
					m.turnTimeoutQuestion(asked, turnTimeoutMs),
					undefined,
					"owner",
					undefined,
					undefined,
					{
						supersede: controller.signal,
						purpose: "turn-timeout",
						wording: {
							approve: m.turnTimeoutContinue,
							decline: m.turnTimeoutCancel,
							footer: m.turnTimeoutFooter,
							approved: m.turnTimeoutContinued,
							declined: m.turnTimeoutCancelled,
						},
					},
				)
				.then(answered, (error: unknown) => {
					logger.warn({ channel, err: error }, "timeout card failed");
					answered("unavailable");
				});
		},
		clock,
	);
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
		cancel() {
			budget.cancel();
			closeCard?.(messages().turnTimeoutFinished);
		},
	};
}
