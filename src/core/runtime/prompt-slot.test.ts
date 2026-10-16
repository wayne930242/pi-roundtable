import { expect, test } from "bun:test";
import { PromptSlot, workTimeout } from "./prompt-slot.ts";

test("workTimeout calls expire once after the work time, and cancel stops it", async () => {
	let expired = 0;
	const cancel = workTimeout(40, new PromptSlot(), () => void expired++);
	expect(expired).toBe(0);
	await Bun.sleep(120);
	expect(expired).toBe(1);
	cancel();

	let cancelled = 0;
	workTimeout(40, new PromptSlot(), () => void cancelled++)();
	await Bun.sleep(120);
	expect(cancelled).toBe(0);
});

test("workTimeout does not count the time the slot waited on a card, and looks again no sooner than a second after a look that finds work left", async () => {
	// The slot reports 100 ms of waiting from the start. The 60 ms limit first comes due at 60 ms,
	// finds all of its 60 ms still left (the wait has used the time), and looks again after the
	// floor of a second, not after the 60 ms left, so it fires at about 1,060 ms. Without the floor
	// it would look again at 120 ms and fire at 160.
	const started = Date.now();
	const slot = { waitedMs: (now = Date.now()) => Math.min(now - started, 100) };
	let expiredAt = 0;
	workTimeout(60, slot, () => {
		expiredAt = Date.now() - started;
	});
	await Bun.sleep(100);
	expect(expiredAt).toBe(0);
	for (let i = 0; i < 300 && expiredAt === 0; i++) await Bun.sleep(10);
	expect(expiredAt).toBeGreaterThanOrEqual(1_000);
});
