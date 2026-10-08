import { expect, test } from "bun:test";
import { SeenThrottle } from "./seen-throttle.ts";

const MINUTE = 60_000;

test("being seen is written at most every five minutes at one tier, and at once when it changes", () => {
	const seen = new SeenThrottle();
	expect(seen.take("p", "member", 0, true)).toBe(true);
	expect(seen.take("p", "member", MINUTE, true)).toBe(false);
	expect(seen.take("p", "admin", 2 * MINUTE, true)).toBe(true);
	expect(seen.take("p", "admin", 8 * MINUTE, true)).toBe(true);
	// A refusal the store does not hold yet is written however soon.
	expect(seen.take("p", null, 9 * MINUTE, true)).toBe(true);
	expect(seen.take("p", null, 9 * MINUTE + 1, false)).toBe(true);
	// Forgotten after a failed write, the next is written.
	seen.forget("p");
	expect(seen.take("p", null, 9 * MINUTE + 2, true)).toBe(true);
});

test("refused then served comes back at once; refused and served by turns is held at no tier until it settles", () => {
	const seen = new SeenThrottle();
	let now = 0;
	const step = () => {
		now += 1_000;
		return now;
	};
	expect(seen.take("p", "member", now, true)).toBe(true);
	expect(seen.take("p", null, step(), true)).toBe(true);
	expect(seen.take("p", "member", step(), true)).toBe(true);
	let writes = 0;
	for (let i = 0; i < 20; i++) {
		if (seen.take("p", null, step(), true)) writes++;
		if (seen.take("p", "member", step(), true)) writes++;
	}
	expect(writes).toBe(1);
	// Five minutes after the last refusal it is written, served, again.
	now += 5 * 60_000;
	expect(seen.take("p", "member", now, true)).toBe(true);
	// Another principal is its own.
	expect(seen.take("q", null, now, true)).toBe(true);
});
