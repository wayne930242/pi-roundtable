import { describe, expect, test } from "bun:test";
import type { TurnTimeout } from "../domain/turn-timeout.ts";
import type {
	Approval,
	ApprovalOptions,
	Prompts,
} from "../interactions/prompts.ts";
import type { Logger } from "../log.ts";
import {
	type BudgetClock,
	runtimeTurnBudget,
	type TurnLimit,
	turnBudget,
} from "./turn-budget.ts";

const MIN = 60_000;

/** A clock moved by hand, whose timers fire as it passes them. */
function fakeClock() {
	let now = 0;
	let scheduled = 0;
	let timers: { at: number; run: () => void }[] = [];
	const clock: BudgetClock = {
		now: () => now,
		schedule: (run, ms) => {
			scheduled++;
			const timer = { at: now + ms, run };
			timers.push(timer);
			return () => {
				timers = timers.filter((t) => t !== timer);
			};
		},
	};
	const advanceTo = (to: number) => {
		for (;;) {
			const next = timers
				.filter((t) => t.at <= to)
				.sort((a, b) => a.at - b.at)[0];
			if (!next) break;
			timers = timers.filter((t) => t !== next);
			now = next.at;
			next.run();
		}
		now = to;
	};
	return { clock, advanceTo, scheduled: () => scheduled };
}

function budget(waited: () => number = () => 0) {
	const { clock, advanceTo } = fakeClock();
	const fired: { at: number; limit: TurnLimit }[] = [];
	const b = turnBudget(
		10 * MIN,
		30 * MIN,
		{ waitedMs: () => waited() },
		(limit) => fired.push({ at: clock.now(), limit }),
		clock,
	);
	return { b, fired, advanceTo };
}

describe("turnBudget", () => {
	test("without a steer the turn ends at its timeout, as before", () => {
		const { fired, advanceTo } = budget();
		advanceTo(10 * MIN - 1);
		expect(fired).toEqual([]);
		advanceTo(11 * MIN);
		expect(fired).toEqual([{ at: 10 * MIN, limit: "turn" }]);
	});

	test("a steer at 6 minutes renews: no abort at 10, abort at 16 when idle", () => {
		const { b, fired, advanceTo } = budget();
		advanceTo(6 * MIN);
		expect(b.renew()).toBe(10 * MIN);
		advanceTo(15 * MIN);
		expect(fired).toEqual([]);
		advanceTo(20 * MIN);
		expect(fired).toEqual([{ at: 16 * MIN, limit: "turn" }]);
	});

	test("repeated steers stop renewing at the cap, the cap aborts, and a steer after it is refused", () => {
		const { b, fired, advanceTo } = budget();
		advanceTo(8 * MIN);
		expect(b.renew()).toBe(10 * MIN);
		advanceTo(16 * MIN);
		expect(b.renew()).toBe(10 * MIN);
		advanceTo(25 * MIN);
		// Renewed to 35 minutes, but held to the 30-minute cap.
		expect(b.renew()).toBe(5 * MIN);
		expect(b.capped()).toBe(false);
		advanceTo(29 * MIN);
		expect(fired).toEqual([]);
		advanceTo(40 * MIN);
		expect(fired).toEqual([{ at: 30 * MIN, limit: "turnMax" }]);
		expect(b.capped()).toBe(true);
		expect(b.renew()).toBeUndefined();
	});

	test("time waiting on the owner's cards counts towards neither limit", () => {
		let waited = 0;
		const { b, fired, advanceTo } = budget(() => waited);
		advanceTo(5 * MIN);
		waited = 20 * MIN;
		advanceTo(25 * MIN);
		// Worked 5 minutes so far: the renewal runs from there.
		expect(b.renew()).toBe(10 * MIN);
		advanceTo(34 * MIN);
		expect(fired).toEqual([]);
		advanceTo(36 * MIN);
		expect(fired).toEqual([{ at: 35 * MIN, limit: "turn" }]);
	});

	test("cancel stops the timer", () => {
		const { b, fired, advanceTo } = budget();
		b.cancel();
		advanceTo(60 * MIN);
		expect(fired).toEqual([]);
	});

	test("a card left open as the limit comes due is looked at about once a second, not once a millisecond, and the limit still fires once", () => {
		const { clock, advanceTo, scheduled } = fakeClock();
		const fired: { at: number; limit: TurnLimit }[] = [];
		// A card opens 1 ms before the 10-minute limit and stays open a minute and a half-second.
		const opened = 10 * MIN - 1;
		const closed = opened + 60_500;
		const waitedMs = (now = clock.now()) =>
			Math.max(0, Math.min(now, closed) - opened);
		turnBudget(
			10 * MIN,
			30 * MIN,
			{ waitedMs },
			(limit) => fired.push({ at: clock.now(), limit }),
			clock,
		);
		advanceTo(closed);
		// Nothing fires while the card is open, and the looks are bounded by the floor, not by the
		// millisecond left (60,500 timers without it).
		expect(fired).toEqual([]);
		expect(scheduled()).toBeLessThanOrEqual(1 + 61);
		advanceTo(closed + 10 * MIN);
		// The turn had 1 ms of work left when the card closed: the limit fires once, no sooner than
		// that and less than the floor late.
		expect(fired).toHaveLength(1);
		expect(fired[0]?.limit).toBe("turn");
		expect(fired[0]?.at).toBeGreaterThanOrEqual(closed + 1);
		expect(fired[0]?.at).toBeLessThan(closed + 1 + 1_000);
		expect(scheduled()).toBeLessThanOrEqual(1 + 62);
	});

	test("a card that closes before the limit leaves it on time", () => {
		const { clock, advanceTo, scheduled } = fakeClock();
		const fired: { at: number; limit: TurnLimit }[] = [];
		// The card is open for the first 5 minutes of the turn, so the limit is due at 15.
		const waitedMs = (now = clock.now()) => Math.min(now, 5 * MIN);
		turnBudget(
			10 * MIN,
			30 * MIN,
			{ waitedMs },
			(limit) => fired.push({ at: clock.now(), limit }),
			clock,
		);
		advanceTo(15 * MIN - 1);
		expect(fired).toEqual([]);
		advanceTo(20 * MIN);
		expect(fired).toEqual([{ at: 15 * MIN, limit: "turn" }]);
		expect(scheduled()).toBe(2);
	});
});

/** The runtime's budget over a fake clock, with a recording logger and a card surface that records each ask. */
function longRunning(options: {
	keepGoing?: (workedMs: number) => boolean;
	cards?: boolean;
	turnMaxMs?: number;
}) {
	const { clock, advanceTo } = fakeClock();
	const asked: ApprovalOptions[] = [];
	const logged: string[] = [];
	const aborted: TurnTimeout[] = [];
	const prompts: Prompts = {
		confirm: (_title, _message, _signal, _minTier, _wait, _details, opts) =>
			new Promise<Approval>(() => {
				if (opts) asked.push(opts);
			}),
		ask: async () => undefined,
	};
	const info = (_fields: unknown, message: string) => logged.push(message);
	const logger = {
		info,
		warn: () => {},
		error: () => {},
		debug: () => {},
		child: () => logger,
	} as unknown as Logger;
	const budget = runtimeTurnBudget(
		{
			logger,
			turnTimeoutMs: 10 * MIN,
			...(options.turnMaxMs ? { turnMaxMs: options.turnMaxMs } : {}),
		},
		{
			waitedMs: () => 0,
			cards: options.cards === false ? undefined : prompts,
		},
		"app:agent.guide",
		(timeout) => aborted.push(timeout),
		{
			activity: { now: () => ({ running: [], compacting: false, tools: [] }) },
			clock,
			...(options.keepGoing ? { keepGoing: options.keepGoing } : {}),
		},
	);
	return { budget, asked, logged, aborted, advanceTo };
}

describe("a turn in long-running mode", () => {
	const CAP = 60 * MIN;
	const keepGoing = (workedMs: number) => workedMs < CAP;

	test("keeps going below the cap without asking, limit after limit, and cards at the cap with purpose turn-timeout", () => {
		const { asked, logged, aborted, advanceTo, budget } = longRunning({
			keepGoing,
		});
		advanceTo(10 * MIN);
		expect(asked).toEqual([]);
		expect(budget.capped()).toBe(false);
		// The turn's own 30-minute cap is raised as it goes, not hit.
		advanceTo(59 * MIN);
		expect(asked).toEqual([]);
		expect(aborted).toEqual([]);
		expect(
			logged.filter((line) => line === "long-running mode continued the turn"),
		).toHaveLength(5);
		advanceTo(60 * MIN);
		expect(asked).toHaveLength(1);
		expect(asked[0]?.purpose).toBe("turn-timeout");
		expect(aborted).toEqual([]);
	});

	test("the turn's own cap is raised as it goes, so steering stays possible", () => {
		const { advanceTo, budget } = longRunning({
			keepGoing,
			turnMaxMs: 15 * MIN,
		});
		advanceTo(15 * MIN);
		// Past the 15-minute cap the turn went on instead of stopping.
		expect(budget.capped()).toBe(false);
		advanceTo(16 * MIN);
		// Raised at minute 15 to a full budget from then, so 9 minutes remain of it.
		expect(budget.renew()).toBe(9 * MIN);
	});

	test("without a card surface it goes on to the cap and is then aborted as before", () => {
		const { asked, aborted, advanceTo } = longRunning({
			keepGoing,
			cards: false,
		});
		advanceTo(59 * MIN);
		expect(aborted).toEqual([]);
		advanceTo(60 * MIN);
		expect(asked).toEqual([]);
		expect(aborted).toHaveLength(1);
		expect(aborted[0]).toMatchObject({ end: "timeout", workedMs: 60 * MIN });
	});

	test("with no keepGoing, or when it says no, the limit asks as it always did", () => {
		for (const given of [undefined, () => false]) {
			const { asked, advanceTo } = longRunning(
				given ? { keepGoing: given } : {},
			);
			advanceTo(10 * MIN);
			expect(asked).toHaveLength(1);
			expect(asked[0]?.purpose).toBe("turn-timeout");
		}
	});
});
