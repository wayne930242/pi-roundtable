import { describe, expect, test } from "bun:test";
import { minutesOfDay, QuietClock } from "./quiet-hours.ts";

/** A moment given as an ISO instant. */
const at = (iso: string): number => Date.parse(iso);

describe("quiet hours", () => {
	test("a time of day is HH:MM on a 24-hour clock, and nothing else", () => {
		expect(minutesOfDay("00:00")).toBe(0);
		expect(minutesOfDay("08:30")).toBe(510);
		expect(minutesOfDay("23:59")).toBe(1439);
		for (const bad of [
			"24:00",
			"8:00",
			"08:60",
			"08:00:00",
			"0800",
			"",
			" 08:00",
		])
			expect(minutesOfDay(bad)).toBeUndefined();
	});

	test("a window that crosses midnight is quiet on both sides of it", () => {
		const clock = new QuietClock({ start: "23:00", end: "08:00" }, "UTC");
		expect(clock.quietAt(at("2026-10-29T22:59:00Z"))).toBe(false);
		expect(clock.quietAt(at("2026-10-29T23:00:00Z"))).toBe(true);
		expect(clock.quietAt(at("2026-10-30T00:00:00Z"))).toBe(true);
		expect(clock.quietAt(at("2026-10-30T07:59:59Z"))).toBe(true);
		expect(clock.quietAt(at("2026-10-30T08:00:00Z"))).toBe(false);
		expect(clock.quietAt(at("2026-10-30T12:00:00Z"))).toBe(false);
	});

	test("a window inside one day is quiet only between its ends", () => {
		const clock = new QuietClock({ start: "13:00", end: "14:30" }, "UTC");
		expect(clock.quietAt(at("2026-10-29T12:59:00Z"))).toBe(false);
		expect(clock.quietAt(at("2026-10-29T13:00:00Z"))).toBe(true);
		expect(clock.quietAt(at("2026-10-29T14:29:00Z"))).toBe(true);
		expect(clock.quietAt(at("2026-10-29T14:30:00Z"))).toBe(false);
	});

	test("the clock is the one in the given zone, not the server's", () => {
		const clock = new QuietClock(
			{ start: "23:00", end: "08:00" },
			"Asia/Taipei",
		);
		// 15:30 UTC is 23:30 in Taipei; 23:30 UTC is 07:30 there; 00:30 UTC is 08:30 there.
		expect(clock.quietAt(at("2026-10-29T15:30:00Z"))).toBe(true);
		expect(clock.quietAt(at("2026-10-29T23:30:00Z"))).toBe(true);
		expect(clock.quietAt(at("2026-10-30T00:30:00Z"))).toBe(false);
		// 14:30 UTC is 22:30 in Taipei, an hour before the window.
		expect(clock.quietAt(at("2026-10-29T14:30:00Z"))).toBe(false);
	});

	test("a zone that observes daylight time follows its offset at that date", () => {
		const clock = new QuietClock(
			{ start: "23:00", end: "08:00" },
			"America/New_York",
		);
		// New York is UTC-4 on 2026-10-29 and UTC-5 after the clocks go back on 2026-11-01.
		expect(clock.quietAt(at("2026-10-30T02:30:00Z"))).toBe(false);
		expect(clock.quietAt(at("2026-10-30T03:30:00Z"))).toBe(true);
		expect(clock.quietAt(at("2026-11-02T03:30:00Z"))).toBe(false);
		expect(clock.quietAt(at("2026-11-02T04:30:00Z"))).toBe(true);
	});

	test("midnight is hour 0 and never 24", () => {
		const clock = new QuietClock({ start: "00:00", end: "06:00" }, "UTC");
		expect(clock.quietAt(at("2026-10-29T00:00:00Z"))).toBe(true);
		expect(clock.quietAt(at("2026-10-29T06:00:00Z"))).toBe(false);
	});
});
