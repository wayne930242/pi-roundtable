import { describe, expect, test } from "bun:test";
import {
	DONE_MS,
	ERROR_MS,
	type PresenceInput,
	presenceOf,
	SLEEPY_AFTER_MS,
	stateChangesIn,
} from "./lib/presence.ts";

const HOUR = 3_600_000;
/** 14:00 local, so the night rule does not apply unless a test moves the clock. */
const NOON = new Date(2026, 9, 28, 14, 0, 0).getTime();
const NIGHT = new Date(2026, 9, 28, 3, 0, 0).getTime();

const quiet: PresenceInput = {
	typing: false,
	prompts: 0,
	busyElsewhere: false,
	lastActivityAt: NOON - HOUR,
};
const input = (over: Partial<PresenceInput> = {}): PresenceInput => ({
	...quiet,
	...over,
});

describe("presenceOf", () => {
	test("a room with nothing going on is idle", () => {
		expect(presenceOf(quiet, NOON)).toBe("idle");
	});

	test("a card open in the room means waiting, and waiting beats working", () => {
		expect(presenceOf(input({ prompts: 1 }), NOON)).toBe("waiting");
		expect(
			presenceOf(
				input({
					prompts: 2,
					typing: true,
					phase: "working",
					outcome: "failed",
				}),
				NOON,
			),
		).toBe("waiting");
	});

	test("typing during a tool call is working", () => {
		expect(presenceOf(input({ typing: true, phase: "working" }), NOON)).toBe(
			"working",
		);
	});

	test("typing without a tool call is thinking when the phase is known, and working when it is not", () => {
		expect(presenceOf(input({ typing: true, phase: "thinking" }), NOON)).toBe(
			"thinking",
		);
		expect(presenceOf(input({ typing: true }), NOON)).toBe("working");
	});

	test("an agent busy elsewhere (Discord, another room) shows as working until the phase says more", () => {
		expect(presenceOf(input({ busyElsewhere: true }), NOON)).toBe("working");
		expect(
			presenceOf(input({ busyElsewhere: true, phase: "thinking" }), NOON),
		).toBe("thinking");
	});

	test("a failed turn is error until the next turn starts, at most ten minutes", () => {
		const failed = input({ outcome: "failed", outcomeAt: NOON - 60_000 });
		expect(presenceOf(failed, NOON)).toBe("error");
		expect(presenceOf(failed, NOON + ERROR_MS)).toBe("idle");
		// Still error four minutes on: it persists, it does not fade like done.
		expect(presenceOf(failed, NOON + 4 * 60_000)).toBe("error");
		// The next turn starts: typing outranks the old failure.
		expect(
			presenceOf({ ...failed, typing: true, phase: "thinking" }, NOON),
		).toBe("thinking");
	});

	test("a finished turn is done for 2.5 seconds, then idle", () => {
		const finished = input({ outcome: "done", outcomeAt: NOON - 1000 });
		expect(presenceOf(finished, NOON)).toBe("done");
		expect(presenceOf(finished, NOON - 1000 + DONE_MS - 1)).toBe("done");
		expect(presenceOf(finished, NOON - 1000 + DONE_MS)).toBe("idle");
	});

	test("done never outlives the work that follows it", () => {
		const finished = input({
			outcome: "done",
			outcomeAt: NOON - 500,
			typing: true,
			phase: "working",
		});
		expect(presenceOf(finished, NOON)).toBe("working");
	});

	test("an agent quiet for more than eight hours is sleepy", () => {
		expect(
			presenceOf(input({ lastActivityAt: NOON - SLEEPY_AFTER_MS - 1 }), NOON),
		).toBe("sleepy");
		expect(
			presenceOf(
				input({ lastActivityAt: NOON - SLEEPY_AFTER_MS + 1000 }),
				NOON,
			),
		).toBe("idle");
	});

	test("between 01:00 and 06:00 local time with nothing in the last hour is sleepy", () => {
		expect(presenceOf(input({ lastActivityAt: NIGHT - 2 * HOUR }), NIGHT)).toBe(
			"sleepy",
		);
		// Something happened within the hour: awake.
		expect(
			presenceOf(input({ lastActivityAt: NIGHT - 10 * 60_000 }), NIGHT),
		).toBe("idle");
		// The same quiet hour in the afternoon is not sleepy.
		expect(presenceOf(input({ lastActivityAt: NOON - 2 * HOUR }), NOON)).toBe(
			"idle",
		);
		const six = new Date(2026, 9, 28, 6, 0, 0).getTime();
		expect(presenceOf(input({ lastActivityAt: six - 2 * HOUR }), six)).toBe(
			"idle",
		);
		const one = new Date(2026, 9, 28, 1, 0, 0).getTime();
		expect(presenceOf(input({ lastActivityAt: one - 2 * HOUR }), one)).toBe(
			"sleepy",
		);
	});

	test("a room nobody has used is sleepy only at night", () => {
		expect(presenceOf(input({ lastActivityAt: undefined }), NOON)).toBe("idle");
		expect(presenceOf(input({ lastActivityAt: undefined }), NIGHT)).toBe(
			"sleepy",
		);
	});

	test("sleepy never hides work, a failure or a card", () => {
		expect(
			presenceOf(
				input({ typing: true, lastActivityAt: NIGHT - 9 * HOUR }),
				NIGHT,
			),
		).toBe("working");
		expect(
			presenceOf(
				input({
					outcome: "failed",
					outcomeAt: NIGHT - 60_000,
					lastActivityAt: NIGHT - 9 * HOUR,
				}),
				NIGHT,
			),
		).toBe("error");
		expect(
			presenceOf(
				input({ prompts: 1, lastActivityAt: NIGHT - 9 * HOUR }),
				NIGHT,
			),
		).toBe("waiting");
	});
});

describe("stateChangesIn", () => {
	test("says when done and error lapse, so the page can draw again then", () => {
		expect(
			stateChangesIn(input({ outcome: "done", outcomeAt: NOON - 500 }), NOON),
		).toBe(DONE_MS - 500);
		expect(
			stateChangesIn(
				input({ outcome: "failed", outcomeAt: NOON - 1000 }),
				NOON,
			),
		).toBe(ERROR_MS - 1000);
		expect(stateChangesIn(quiet, NOON)).toBeUndefined();
		// Typing outranks the outcome, so nothing lapses on its own.
		expect(
			stateChangesIn(
				input({ outcome: "done", outcomeAt: NOON, typing: true }),
				NOON,
			),
		).toBeUndefined();
	});
});
