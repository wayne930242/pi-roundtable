import { describe, expect, test } from "bun:test";
import { STATE_EXPRESSION } from "pi-roundtable/characters";
import {
	createExpressionSwaps,
	seatExpressionOf,
	seatStateOf,
	seatStates,
} from "./lib/seats.ts";

describe("seatStateOf", () => {
	test("sleepy sits as idle, and every other state is kept", () => {
		expect(seatStateOf("sleepy")).toBe("idle");
		for (const state of [
			"idle",
			"thinking",
			"working",
			"waiting",
			"done",
			"error",
		] as const)
			expect(seatStateOf(state)).toBe(state);
	});
});

describe("seatStates", () => {
	const agents = { a: "idle", b: "working", c: "sleepy" } as const;

	test("a group room typing with agent b lights b as speaking", () => {
		const states = seatStates(agents, [{ typing: true, agent: "b" }]);
		expect(states).toEqual({ a: "idle", b: "speaking", c: "idle" });
	});

	test("a group room that is not typing lights nobody", () => {
		expect(seatStates(agents, [{ typing: false, agent: "b" }])).toEqual({
			a: "idle",
			b: "working",
			c: "idle",
		});
	});

	test("a speaker who has no seat is ignored", () => {
		expect(seatStates(agents, [{ typing: true, agent: "zed" }])).toEqual({
			a: "idle",
			b: "working",
			c: "idle",
		});
	});

	test("a waiting card still shows under a speaking round: speaking wins only over quiet states", () => {
		const states = seatStates({ a: "waiting", b: "idle" }, [
			{ typing: true, agent: "a" },
		]);
		expect(states.a).toBe("waiting");
	});
});

describe("seatExpressionOf", () => {
	test("a seat wears its state's expression, and speaking has its own", () => {
		expect(seatExpressionOf("idle")).toBe(STATE_EXPRESSION.idle);
		expect(seatExpressionOf("working")).toBe(STATE_EXPRESSION.working);
		expect(seatExpressionOf("speaking")).not.toBe(STATE_EXPRESSION.idle);
	});
});

/** A clock the test moves by hand. */
function clock() {
	let now = 0;
	const due: { at: number; run: () => void; id: number }[] = [];
	let next = 1;
	return {
		set: (run: () => void, ms: number) => {
			const id = next++;
			due.push({ at: now + ms, run, id });
			return id as unknown as ReturnType<typeof setTimeout>;
		},
		clear: (id: ReturnType<typeof setTimeout>) => {
			const at = due.findIndex(
				(entry) => entry.id === (id as unknown as number),
			);
			if (at >= 0) due.splice(at, 1);
		},
		advance(ms: number) {
			now += ms;
			for (const entry of [...due].sort((p, q) => p.at - q.at))
				if (entry.at <= now) {
					due.splice(due.indexOf(entry), 1);
					entry.run();
				}
		},
	};
}

describe("createExpressionSwaps", () => {
	function swaps() {
		const time = clock();
		const calls: [string, string][] = [];
		const swapper = createExpressionSwaps({
			delayMs: 300,
			setAvatar: (id, state) => void calls.push([id, state]),
			timers: { set: time.set, clear: time.clear },
		});
		return { time, calls, swapper };
	}

	test("a state change whose expression differs calls setAvatar once after 300 ms", () => {
		const { time, calls, swapper } = swaps();
		swapper.update("a", "idle");
		swapper.update("a", "working");
		time.advance(299);
		expect(calls).toEqual([]);
		time.advance(1);
		expect(calls).toEqual([["a", "working"]]);
		time.advance(2000);
		expect(calls).toHaveLength(1);
	});

	test("the first state of a seat is its first picture and is not swapped", () => {
		const { time, calls, swapper } = swaps();
		swapper.update("a", "thinking");
		time.advance(1000);
		expect(calls).toEqual([]);
	});

	test("a state with the same expression does not call setAvatar", () => {
		const { time, calls, swapper } = swaps();
		swapper.update("a", "idle");
		// Repeating the state, or a pending change that goes back before it lands, swaps nothing.
		swapper.update("a", "idle");
		swapper.update("a", "working");
		time.advance(100);
		swapper.update("a", "idle");
		time.advance(1000);
		expect(calls).toEqual([]);
	});

	test("a burst of changes waits for the last one", () => {
		const { time, calls, swapper } = swaps();
		swapper.update("a", "idle");
		swapper.update("a", "thinking");
		time.advance(200);
		swapper.update("a", "working");
		time.advance(200);
		expect(calls).toEqual([]);
		time.advance(100);
		expect(calls).toEqual([["a", "working"]]);
	});

	test("seats swap on their own clocks, and forgetting a seat drops its pending swap", () => {
		const { time, calls, swapper } = swaps();
		swapper.update("a", "idle");
		swapper.update("b", "idle");
		swapper.update("a", "error");
		swapper.update("b", "done");
		swapper.forget("b");
		time.advance(300);
		expect(calls).toEqual([["a", "error"]]);
	});

	test("dispose cancels what is pending", () => {
		const { time, calls, swapper } = swaps();
		swapper.update("a", "idle");
		swapper.update("a", "error");
		swapper.dispose();
		time.advance(1000);
		expect(calls).toEqual([]);
	});
});
