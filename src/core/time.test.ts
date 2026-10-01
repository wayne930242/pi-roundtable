import { afterEach, describe, expect, test } from "bun:test";
import { setLocale } from "./i18n/index.ts";
import { nextRun, parseRecurrence } from "./modules/schedules/recurrence.ts";
import { scheduleToolSpecs } from "./shared/schedule-tools.ts";
import { useTestLocale } from "./testing/locale.ts";
import {
	setTimeZone,
	timeZone,
	zonedDate,
	zonedInstant,
	zonedStamp,
	zonedStampIn,
	zonedToday,
} from "./time.ts";

afterEach(useTestLocale);

describe("configured time zone", () => {
	test("defaults to UTC before a host configures the process", () => {
		const result = Bun.spawnSync({
			cmd: [
				"bun",
				"-e",
				'import { timeZone } from "./src/core/time.ts"; console.log(timeZone())',
			],
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString().trim()).toBe("UTC");
	});

	test("rejects an invalid zone without changing the current one", () => {
		setTimeZone("UTC");
		expect(() => setTimeZone("Not/A_Zone")).toThrow("Not/A_Zone");
		expect(timeZone()).toBe("UTC");
	});

	test("Taipei agrees with the former +8 arithmetic for a year-long sweep", () => {
		setTimeZone("Asia/Taipei");
		const start = Date.parse("2026-01-01T00:00:00Z");
		for (let i = 0; i < 366; i += 1) {
			const at = new Date(start + i * 86_400_000 + i * 61_000);
			const old = new Date(at.getTime() + 8 * 3_600_000).toISOString();
			expect(zonedDate(at)).toBe(old.slice(0, 10));
			expect(zonedStamp(at)).toBe(old.slice(0, 16).replace("T", " "));
		}
		expect(zonedToday()).toBe(zonedDate(new Date()));
	});

	test("New York resolves spring gaps later and fall folds to the first occurrence", () => {
		setTimeZone("America/New_York");
		expect(zonedInstant("2026-03-08", "02:30").toISOString()).toBe(
			"2026-03-08T07:30:00.000Z",
		);
		expect(zonedStamp(zonedInstant("2026-03-08", "02:30"))).toBe(
			"2026-03-08 03:30",
		);
		expect(zonedInstant("2026-11-01", "01:30").toISOString()).toBe(
			"2026-11-01T05:30:00.000Z",
		);
	});

	test("handles +14 and half-hour offsets", () => {
		setTimeZone("Pacific/Kiritimati");
		expect(zonedInstant("2026-07-01", "09:15").toISOString()).toBe(
			"2026-06-30T19:15:00.000Z",
		);
		setTimeZone("America/St_Johns");
		expect(zonedInstant("2026-01-01", "09:15").toISOString()).toBe(
			"2026-01-01T12:45:00.000Z",
		);
		expect(zonedInstant("2026-07-01", "09:15").toISOString()).toBe(
			"2026-07-01T11:45:00.000Z",
		);
	});

	test("daily, weekly, and interval recurrence stay at wall-clock time across DST", () => {
		setTimeZone("America/New_York");
		const before = new Date("2026-03-07T15:00:00Z");
		const daily = parseRecurrence(
			{ time: "09:00", start_date: "2026-03-07" },
			before,
		);
		expect(nextRun(daily, before)?.toISOString()).toBe(
			"2026-03-08T13:00:00.000Z",
		);
		expect(
			nextRun(daily, new Date("2026-03-08T13:00:00Z"))?.toISOString(),
		).toBe("2026-03-09T13:00:00.000Z");
		expect(
			nextRun(daily, new Date("2026-10-31T13:00:00Z"))?.toISOString(),
		).toBe("2026-11-01T14:00:00.000Z");
		const weekly = parseRecurrence(
			{ time: "09:00", weekdays: ["sun"] },
			before,
		);
		expect(nextRun(weekly, before)?.toISOString()).toBe(
			"2026-03-08T13:00:00.000Z",
		);
		expect(
			nextRun(weekly, new Date("2026-03-08T13:00:00Z"))?.toISOString(),
		).toBe("2026-03-15T13:00:00.000Z");
		const interval = parseRecurrence(
			{ time: "09:00", every_days: 2, start_date: "2026-03-07" },
			before,
		);
		expect(nextRun(interval, before)?.toISOString()).toBe(
			"2026-03-09T13:00:00.000Z",
		);
		expect(
			nextRun(
				{ kind: "once", date: "2026-11-01", time: "01:30" },
				new Date("2026-10-31T12:00:00Z"),
			)?.toISOString(),
		).toBe("2026-11-01T05:30:00.000Z");
	});

	test("the wording of every catalog derives from the configured zone, with none special", () => {
		const errors = () => [
			() => parseRecurrence({ at: "soon" }, new Date()),
			() => parseRecurrence({ time: "soon" }, new Date()),
		];
		const messagesFor = (locale: "en" | "zh-TW") => {
			setLocale(locale, { assistant: "Roundtable", root: "roundtable" });
			return errors().map((run) => {
				try {
					run();
				} catch (error) {
					return String(error);
				}
				throw new Error("expected the recurrence to be refused");
			});
		};
		setTimeZone("Europe/Berlin");
		expect(messagesFor("en")).toEqual([
			expect.stringContaining('at must be Europe/Berlin time as "YYYY-MM-DD'),
			expect.stringContaining('"HH:MM", Europe/Berlin) to repeat'),
		]);
		setTimeZone("America/Argentina/Buenos_Aires");
		expect(messagesFor("zh-TW")).toEqual([
			expect.stringContaining('at must be Buenos Aires time as "YYYY-MM-DD'),
			expect.stringContaining('"HH:MM", Buenos Aires) to repeat'),
		]);
		setTimeZone("UTC");
		expect(
			scheduleToolSpecs({ locale: "en", timeZone: "UTC" })[0]?.description,
		).toContain("UTC time");
	});

	test("relative once scheduling preserves the second occurrence of a fall-back hour", () => {
		setTimeZone("America/New_York");
		const now = new Date("2026-11-01T06:10:00Z");
		const once = parseRecurrence({ in_minutes: 20 }, now);
		expect(nextRun(once, now)?.toISOString()).toBe("2026-11-01T06:30:00.000Z");
	});

	test("tool descriptions take the locale and zone they are given, not the process's", () => {
		setTimeZone("America/New_York");
		setLocale("en", { assistant: "Roundtable", root: "roundtable" });
		const description = (locale: "en" | "zh-TW", timeZone: string) =>
			scheduleToolSpecs({ locale, timeZone })[0]?.description;
		expect(description("en", "Asia/Taipei")).toContain("set Asia/Taipei time");
		expect(description("zh-TW", "Asia/Taipei")).toContain("set Taipei time");
		expect(description("en", "America/New_York")).toContain(
			"America/New_York time",
		);
	});

	test("a stamp is written in the zone it is given, apart from the host's", () => {
		setTimeZone("UTC");
		const at = new Date("2026-09-29T20:00:00Z");
		expect(zonedStampIn(at, "Asia/Taipei")).toBe("2026-09-30 04:00");
		expect(zonedStamp(at)).toBe("2026-09-29 20:00");
	});
});
