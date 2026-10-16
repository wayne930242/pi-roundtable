import { describe, expect, test } from "bun:test";
import { type BudgetClock, type TurnLimit, turnBudget } from "./turn-budget.ts";

const MIN = 60_000;

/** A clock moved by hand, whose timers fire as it passes them. */
function fakeClock() {
	let now = 0;
	let timers: { at: number; run: () => void }[] = [];
	const clock: BudgetClock = {
		now: () => now,
		schedule: (run, ms) => {
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
	return { clock, advanceTo };
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
});
