import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { SQL } from "bun";
import { ScheduleError } from "../../domain/errors.ts";
import { messages } from "../../i18n/index.ts";
import { silentLogger } from "../../log.ts";
import {
	describeDb,
	openTestStore,
	type TestStore,
	testDatabaseUrl,
} from "../../testing/database.ts";
import { useTestLocale } from "../../testing/locale.ts";
import { setTimeZone, zonedStamp } from "../../time.ts";
import { describeRecurrence, nextRun, parseRecurrence } from "./recurrence.ts";
import { type Schedule, ScheduleStore } from "./schedule-store.ts";
import {
	callScheduleTool,
	SCHEDULE_LIMITS,
	type ScheduleToolContext,
	scheduledTurnText,
} from "./schedule-tools.ts";
import { type ScheduledOutcome, Scheduler } from "./scheduler.ts";

const taipei = (stamp: string) =>
	new Date(`${stamp.replace(" ", "T")}:00+08:00`);

// The schedules below are written in Taipei time; the suite's other files keep the neutral zone.
beforeAll(() => setTimeZone("Asia/Taipei"));
afterAll(useTestLocale);

describe("recurrence", () => {
	const now = taipei("2026-09-26 23:30");

	test("a one-time run is the given Taipei time, and none once it has passed", () => {
		const once = parseRecurrence({ at: "2026-09-27 09:00" }, now);
		expect(nextRun(once, now)).toEqual(taipei("2026-09-27 09:00"));
		expect(nextRun(once, taipei("2026-09-27 09:00"))).toBeUndefined();
	});

	test("in_minutes is one run that many minutes ahead, rounded up to the minute", () => {
		const at = new Date(taipei("2026-09-26 23:58").getTime() + 30_000);
		const relative = parseRecurrence({ in_minutes: 2 }, at);
		expect(relative).toEqual({
			kind: "once",
			date: "2026-09-27",
			time: "00:01",
		});
		expect(() =>
			parseRecurrence({ in_minutes: 2, at: "2026-09-27 09:00" }, at),
		).toThrow(ScheduleError);
		expect(() => parseRecurrence({ in_minutes: 0 }, at)).toThrow(ScheduleError);
	});

	test("every n days counts from the start date and never returns the current instant", () => {
		const every = parseRecurrence(
			{ time: "09:00", every_days: 3, start_date: "2026-09-16" },
			now,
		);
		expect(nextRun(every, now)).toEqual(taipei("2026-09-28 09:00"));
		expect(nextRun(every, taipei("2026-09-28 09:00"))).toEqual(
			taipei("2026-10-01 09:00"),
		);
		expect(describeRecurrence(every)).toBe(
			messages().scheduleEveryDays(3, "09:00", "2026-09-16"),
		);
	});

	test("daily defaults to starting today, so a time still ahead runs today", () => {
		const daily = parseRecurrence({ time: "23:45" }, now);
		expect(nextRun(daily, now)).toEqual(taipei("2026-09-26 23:45"));
		expect(describeRecurrence(daily)).toBe(messages().scheduleDaily("23:45"));
	});

	test("weekly runs on the listed weekdays", () => {
		// 2026-09-26 is a Saturday.
		const weekly = parseRecurrence(
			{ time: "08:00", weekdays: ["wed", "mon"] },
			now,
		);
		expect(nextRun(weekly, now)).toEqual(taipei("2026-09-28 08:00"));
		expect(nextRun(weekly, taipei("2026-09-28 08:00"))).toEqual(
			taipei("2026-09-30 08:00"),
		);
		expect(describeRecurrence(weekly)).toBe(
			messages().scheduleWeekly(
				[messages().scheduleWeekday("mon"), messages().scheduleWeekday("wed")],
				"08:00",
			),
		);
	});

	test("bad timing is refused with a message the model can act on", () => {
		const cases = [
			{},
			{ at: "2026-02-30 09:00" },
			{ at: "tomorrow" },
			{ at: "2026-09-27 09:00", time: "09:00" },
			{ time: "25:00" },
			{ time: "09:00", every_days: 0 },
			{ time: "09:00", weekdays: ["someday"] },
			{ time: "09:00", weekdays: ["mon"], every_days: 2 },
		];
		for (const input of cases)
			expect(() => parseRecurrence(input, now)).toThrow(ScheduleError);
	});
});

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("PostgreSQL", () => {
	let store: TestStore<ScheduleStore>;

	beforeAll(async () => {
		const admin = new SQL(testDatabaseUrl);
		await admin`DROP TABLE IF EXISTS schedules`;
		await admin.close();
		store = await openTestStore(ScheduleStore);
	});

	afterAll(async () => {
		await store.close();
	});

	beforeEach(async () => {
		const admin = new SQL(testDatabaseUrl);
		await admin`TRUNCATE schedules`;
		await admin.close();
	});

	const now = taipei("2026-09-26 23:30");
	const ctx = (
		over: Partial<ScheduleToolContext> = {},
	): ScheduleToolContext => ({
		store,
		channel: "discord:a",
		mode: "party",
		author: { id: "u1", name: "Sam" },
		now,
		...over,
	});

	describe("schedule tools", () => {
		test("a schedule keeps its creator's tier, and a lower tier cannot change it", async () => {
			const admin = { id: "u2", name: "Ada", tier: "admin" } as const;
			const member = { id: "u3", name: "Max", tier: "member" } as const;
			await callScheduleTool(ctx({ author: admin }), "schedule_create", {
				title: "patrol",
				prompt: "check the disk",
				time: "09:00",
				every_days: 1,
			});
			const [schedule] = await store.forChannel("discord:a");
			const id = schedule?.id ?? 0;
			expect(schedule?.createdTier).toBe("admin");
			for (const tool of ["schedule_update", "schedule_cancel"] as const)
				await expect(
					callScheduleTool(ctx({ author: member }), tool, {
						id,
						title: "renamed",
					}),
				).rejects.toThrow(/higher tier/);
			await callScheduleTool(ctx({ author: admin }), "schedule_update", {
				id,
				title: "renamed",
			});
			expect((await store.get(id))?.title).toBe("renamed");
			// The owner's own schedules default to the owner's tier.
			await callScheduleTool(ctx(), "schedule_create", {
				title: "morning report",
				prompt: "report",
				time: "10:00",
				every_days: 1,
			});
			const owners = await store.forChannel("discord:a");
			expect(owners.map((x) => x.createdTier).sort()).toEqual([
				"admin",
				"owner",
			]);
		});

		test("create, list, update, and cancel act on the channel's schedules", async () => {
			const created = await callScheduleTool(ctx(), "schedule_create", {
				title: "jobs",
				prompt: "find pastry shop openings",
				time: "09:00",
				every_days: 3,
				start_date: "2026-09-16",
			});
			expect(created).toContain("first run 2026-09-28 09:00");
			const [schedule] = await store.forChannel("discord:a");
			expect(schedule?.createdByName).toBe("Sam");
			expect(schedule?.mode).toBe("party");

			const id = schedule?.id ?? 0;
			expect(await callScheduleTool(ctx(), "schedule_list", {})).toContain(
				`#${id} jobs`,
			);
			await callScheduleTool(ctx(), "schedule_update", {
				id,
				prompt: "find pastry shop openings; already seen: Acme",
			});
			expect(await callScheduleTool(ctx(), "schedule_list", { id })).toContain(
				"already seen: Acme",
			);
			// Changing only the prompt keeps the timing.
			expect((await store.get(id))?.nextRun).toEqual(
				taipei("2026-09-28 09:00"),
			);

			await callScheduleTool(ctx(), "schedule_update", { id, time: "20:00" });
			expect((await store.get(id))?.nextRun).toEqual(
				taipei("2026-09-27 20:00"),
			);

			expect(
				callScheduleTool(ctx({ channel: "discord:b" }), "schedule_cancel", {
					id,
				}),
			).rejects.toThrow(ScheduleError);
			await callScheduleTool(ctx(), "schedule_cancel", { id });
			expect(await store.forChannel("discord:a")).toEqual([]);
		});

		test("a party channel is limited in count, prompt size, and distance", async () => {
			const { perChannel, promptChars } = SCHEDULE_LIMITS.party;
			for (let i = 0; i < perChannel; i += 1)
				await callScheduleTool(ctx(), "schedule_create", {
					title: `t${i}`,
					prompt: "p",
					time: "10:00",
				});
			expect(
				callScheduleTool(ctx(), "schedule_create", {
					title: "one more",
					prompt: "p",
					time: "10:00",
				}),
			).rejects.toThrow("cancel one first");
			expect(
				callScheduleTool(ctx({ channel: "discord:b" }), "schedule_create", {
					title: "long",
					prompt: "x".repeat(promptChars + 1),
					time: "10:00",
				}),
			).rejects.toThrow(`within ${promptChars}`);
			expect(
				callScheduleTool(ctx({ channel: "discord:b" }), "schedule_create", {
					title: "far",
					prompt: "p",
					at: "2027-09-26 10:00",
				}),
			).rejects.toThrow("within 90 days");
			expect(
				callScheduleTool(ctx({ channel: "discord:b" }), "schedule_create", {
					title: "past",
					prompt: "p",
					at: "2026-09-26 10:00",
				}),
			).rejects.toThrow("already passed");
		});

		test("the scheduled message names the schedule and carries its prompt", async () => {
			await callScheduleTool(ctx(), "schedule_create", {
				title: "drink water",
				prompt: "remind Sam to drink water",
				at: "2026-09-27 09:00",
			});
			const [schedule] = await store.forChannel("discord:a");
			if (!schedule) throw new Error("missing schedule");
			const text = scheduledTurnText(schedule, taipei("2026-09-27 09:00"));
			expect(text).toContain(`#${schedule.id}: drink water`);
			expect(text).toContain("2026-09-27 09:00");
			expect(text.endsWith("remind Sam to drink water")).toBe(true);
		});
	});

	describe("scheduler", () => {
		function scheduler(
			clock: { now: Date },
			fired: Schedule[],
			outcome: ScheduledOutcome,
		) {
			return new Scheduler({
				store,
				runner: {
					runScheduled: async (schedule) => {
						fired.push(schedule);
						return outcome;
					},
				},
				logger: silentLogger(),
				now: () => clock.now,
			});
		}

		test("a due one-time schedule fires once and is deleted", async () => {
			await callScheduleTool(ctx(), "schedule_create", {
				title: "once",
				prompt: "p",
				at: "2026-09-27 09:00",
			});
			const clock = { now: taipei("2026-09-27 08:59") };
			const fired: Schedule[] = [];
			const s = scheduler(clock, fired, { status: "ran" });
			await s.tick();
			expect(fired).toHaveLength(0);
			clock.now = taipei("2026-09-27 09:00");
			await s.tick();
			await s.tick();
			await s.idle();
			expect(fired.map((f) => f.title)).toEqual(["once"]);
			expect(await store.forChannel("discord:a")).toEqual([]);
		});

		test("a repeating schedule moves to its next run and keeps the outcome", async () => {
			await callScheduleTool(ctx(), "schedule_create", {
				title: "daily",
				prompt: "p",
				time: "09:00",
			});
			const clock = { now: taipei("2026-09-27 09:00") };
			const fired: Schedule[] = [];
			const s = scheduler(clock, fired, {
				status: "skipped",
				reason: "party mode is off",
			});
			await s.tick();
			await s.idle();
			const [after] = await store.forChannel("discord:a");
			expect(fired).toHaveLength(1);
			expect(after && zonedStamp(after.nextRun)).toBe("2026-09-28 09:00");
			expect(after?.lastStatus).toBe("skipped: party mode is off");
		});

		test("a run found long after it was due is skipped, not caught up", async () => {
			await callScheduleTool(ctx(), "schedule_create", {
				title: "daily",
				prompt: "p",
				time: "09:00",
			});
			const clock = { now: taipei("2026-09-29 12:00") };
			const fired: Schedule[] = [];
			const s = scheduler(clock, fired, { status: "ran" });
			await s.tick();
			await s.idle();
			const [after] = await store.forChannel("discord:a");
			expect(fired).toHaveLength(0);
			expect(after && zonedStamp(after.nextRun)).toBe("2026-09-30 09:00");
			expect(after?.lastStatus).toBe("skipped: missed while offline");
		});
	});
});
