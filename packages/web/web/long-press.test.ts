import { expect, test } from "bun:test";
import {
	type Clock,
	HOLD_MS,
	LongPress,
	MOVE_LIMIT,
} from "./lib/long-press.ts";

/** A clock the test moves by hand, so the 450 ms hold needs no waiting. */
function manual(): Clock & { advance(ms: number): void; waiting(): number } {
	let now = 0;
	let next = 1;
	const timers = new Map<number, { at: number; run: () => void }>();
	return {
		set(run, ms) {
			const id = next++;
			timers.set(id, { at: now + ms, run });
			return () => {
				timers.delete(id);
			};
		},
		advance(ms: number) {
			now += ms;
			for (const [id, timer] of [...timers])
				if (timer.at <= now) {
					timers.delete(id);
					timer.run();
				}
		},
		waiting: () => timers.size,
	};
}

test("a hold of 450 ms fires once, at the point where the finger went down", () => {
	expect(HOLD_MS).toBe(450);
	const clock = manual();
	const fired: { x: number; y: number }[] = [];
	const press = new LongPress((at) => fired.push(at), clock);
	press.begin(40, 80);
	clock.advance(HOLD_MS - 1);
	expect(fired).toEqual([]);
	expect(press.pending).toBe(true);
	clock.advance(1);
	expect(fired).toEqual([{ x: 40, y: 80 }]);
	expect(press.fired).toBe(true);
	expect(press.pending).toBe(false);
	clock.advance(2000);
	expect(fired.length).toBe(1);
});

test("lifting before 450 ms is a tap and fires nothing", () => {
	const clock = manual();
	let fired = 0;
	const press = new LongPress(() => fired++, clock);
	press.begin(10, 10);
	clock.advance(300);
	expect(press.end()).toBe(false);
	clock.advance(1000);
	expect(fired).toBe(0);
	expect(clock.waiting()).toBe(0);
});

test("a move of more than 10 px cancels the hold; a smaller wobble does not", () => {
	expect(MOVE_LIMIT).toBe(10);
	const clock = manual();
	let fired = 0;
	const press = new LongPress(() => fired++, clock);
	press.begin(100, 100);
	expect(press.move(106, 108)).toBe(true);
	clock.advance(200);
	expect(press.move(100, 111)).toBe(false);
	expect(press.pending).toBe(false);
	clock.advance(1000);
	expect(fired).toBe(0);

	press.begin(100, 100);
	expect(press.move(110, 100)).toBe(true);
	clock.advance(HOLD_MS);
	expect(fired).toBe(1);
});

test("cancel stops a pending hold, and a new begin starts afresh", () => {
	const clock = manual();
	let fired = 0;
	const press = new LongPress(() => fired++, clock);
	press.begin(0, 0);
	press.cancel();
	clock.advance(1000);
	expect(fired).toBe(0);
	press.begin(0, 0);
	expect(press.fired).toBe(false);
	clock.advance(HOLD_MS);
	expect(fired).toBe(1);
	expect(press.end()).toBe(true);
});
