import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { SQL } from "bun";
import type {
	BackgroundTarget,
	BackgroundTurn,
} from "../../contract/channels.ts";
import { migrate } from "../../db/migrations.ts";
import { ScheduleError } from "../../domain/errors.ts";
import { PluginError } from "../../errors.ts";
import { type Logger, silentLogger } from "../../log.ts";
import { runsAsAuthor, runsAsCreator } from "../../testing/background.ts";
import {
	describeDb,
	openTestStore,
	type TestStore,
	testDatabaseUrl,
} from "../../testing/database.ts";
import { useTestLocale } from "../../testing/locale.ts";
import { fakePrecheck, fakePrechecks } from "../../testing/prechecks.ts";
import { recordingLogger } from "../../testing/recording-logger.ts";
import { setTimeZone } from "../../time.ts";
import { ConversationBackgroundTurns } from "../background/background-turns.ts";
import {
	memoryPrecheckRegistry,
	type PrecheckFinding,
	type PrecheckRegistry,
	runPrecheck,
} from "./prechecks.ts";
import { PgScheduleStore, type Schedule } from "./schedule-store.ts";
import {
	callScheduleTool,
	type ScheduleToolContext,
	scheduledTurnText,
} from "./schedule-tools.ts";
import { Scheduler } from "./scheduler.ts";

const OPEN: BackgroundTarget = {
	name: "open",
	label: () => "Open",
	schedules: { perChannel: 5, promptChars: 2_000, aheadDays: 90 },
};

const taipei = (stamp: string) =>
	new Date(`${stamp.replace(" ", "T")}:00+08:00`);

beforeAll(() => setTimeZone("Asia/Taipei"));
afterAll(useTestLocale);

describe("the precheck registry", () => {
	test("refuses a bad or repeated name, an empty description, and a bad timeout", () => {
		const registry = memoryPrecheckRegistry();
		registry.register(fakePrecheck("health.recovery", { wake: false }));
		expect(() =>
			registry.register(fakePrecheck("health.recovery", { wake: false })),
		).toThrow(PluginError);
		expect(() =>
			registry.register(fakePrecheck("Has Spaces", { wake: false })),
		).toThrow(PluginError);
		expect(() =>
			registry.register(
				fakePrecheck("quiet", { wake: false }, { description: " " }),
			),
		).toThrow(PluginError);
		expect(() =>
			registry.register(
				fakePrecheck("slow", { wake: false }, { timeoutMs: 0 }),
			),
		).toThrow(PluginError);
		expect(registry.list().map((p) => p.name)).toEqual(["health.recovery"]);
	});

	test("a precheck that throws, runs out of time, or answers a wrong shape fails, never rejects", async () => {
		const schedule = {} as Schedule;
		const firedAt = new Date();
		expect(
			await runPrecheck(fakePrecheck("boom", new Error("sensor offline")), {
				schedule,
				firedAt,
				tier: "owner",
			}),
		).toEqual({ kind: "failed", error: "it threw: sensor offline" });
		let aborted = false;
		const slow = fakePrecheck(
			"slow",
			(context) =>
				new Promise(() => {
					context.signal.addEventListener("abort", () => {
						aborted = true;
					});
				}),
			{ timeoutMs: 20 },
		);
		expect(
			await runPrecheck(slow, { schedule, firedAt, tier: "owner" }),
		).toEqual({
			kind: "failed",
			error: "it did not answer within 0.02 seconds",
		});
		expect(aborted).toBe(true);
		const wrong = fakePrecheck(
			"wrong",
			() => ({ wake: true }) as unknown as { wake: false },
		);
		const outcome = await runPrecheck(wrong, {
			schedule,
			firedAt,
			tier: "owner",
		});
		expect(outcome.kind).toBe("failed");
	});
});

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("PostgreSQL", () => {
	let store: TestStore<PgScheduleStore>;

	beforeAll(async () => {
		const admin = new SQL(testDatabaseUrl);
		await admin`DROP TABLE IF EXISTS schedules`;
		await admin.close();
		store = await openTestStore(PgScheduleStore);
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
		prechecks?: PrecheckRegistry,
		over: Partial<ScheduleToolContext> = {},
	): ScheduleToolContext => ({
		store,
		channel: "discord:a",
		target: OPEN,
		author: { principalId: "u1", id: "u1", name: "Sam", tier: "owner" },
		now,
		...(prechecks ? { prechecks } : {}),
		...over,
	});

	async function daily(prechecks: PrecheckRegistry, precheck?: string) {
		await callScheduleTool(ctx(prechecks), "schedule_create", {
			title: "recovery",
			prompt: "check last night's recovery and report anything unusual",
			time: "09:30",
			...(precheck ? { precheck } : {}),
		});
		const [schedule] = await store.forChannel("discord:a");
		if (!schedule) throw new Error("missing schedule");
		return schedule;
	}

	/** A scheduler at 09:30 whose turns and notes the test sees. */
	function harness(
		prechecks: PrecheckRegistry,
		logger: Logger = silentLogger(),
	) {
		const turns: { schedule: Schedule; finding?: PrecheckFinding }[] = [];
		const notes: { schedule: Schedule; note: string }[] = [];
		const scheduler = new Scheduler({
			store,
			prechecks,
			runner: {
				runsAs: runsAsCreator,
				runScheduled: async (schedule, _firedAt, finding) => {
					turns.push({ schedule, ...(finding ? { finding } : {}) });
					return { status: "ran" };
				},
			},
			notify: async (schedule, note) => {
				notes.push({ schedule, note });
			},
			logger,
			now: () => taipei("2026-09-27 09:30"),
		});
		return { scheduler, turns, notes };
	}

	test("wake:false starts no turn, posts the note, and records the skip", async () => {
		const prechecks = fakePrechecks(
			fakePrecheck("health.recovery", {
				wake: false,
				note: "recovery normal",
			}),
		);
		const schedule = await daily(prechecks, "health.recovery");
		const { scheduler, turns, notes } = harness(prechecks);
		await scheduler.tick();
		await scheduler.idle();
		expect(turns).toEqual([]);
		expect(notes.map((n) => [n.schedule.id, n.note])).toEqual([
			[schedule.id, "recovery normal"],
		]);
		const after = await store.get(schedule.id);
		expect(after?.lastStatus).toBe("skipped by precheck (recovery normal)");
		// The schedule was taken first, so it moved to its next run as any other.
		expect(after?.nextRun).toEqual(taipei("2026-09-28 09:30"));
		const listed = await callScheduleTool(ctx(prechecks), "schedule_list", {});
		expect(listed).toContain("precheck health.recovery");
		expect(listed).toContain("(skipped by precheck (recovery normal))");
	});

	test("wake:false without a note posts nothing", async () => {
		const prechecks = fakePrechecks(
			fakePrecheck("health.recovery", { wake: false }),
		);
		const schedule = await daily(prechecks, "health.recovery");
		const { scheduler, turns, notes } = harness(prechecks);
		await scheduler.tick();
		await scheduler.idle();
		expect(turns).toEqual([]);
		expect(notes).toEqual([]);
		expect((await store.get(schedule.id))?.lastStatus).toBe(
			"skipped by precheck",
		);
	});

	test("wake:true starts the turn, whose text carries the context", async () => {
		const check = fakePrecheck("health.recovery", {
			wake: true,
			context: "HRV 31 ms, 40% under the 14-day mean",
		});
		const prechecks = fakePrechecks(check);
		const schedule = await daily(prechecks, "health.recovery");
		const background: BackgroundTurn[] = [];
		const scheduler = new Scheduler({
			store,
			prechecks,
			runner: new ConversationBackgroundTurns({
				conversations: {
					runsAs: runsAsAuthor,
					background: async (turn) => {
						background.push(turn);
						return { status: "ran" };
					},
				},
				system: { id: "assistant", name: "Assistant" },
				logger: silentLogger(),
			}),
			logger: silentLogger(),
			now: () => taipei("2026-09-27 09:30"),
		});
		await scheduler.tick();
		await scheduler.idle();
		expect(check.calls.map((c) => c.schedule.id)).toEqual([schedule.id]);
		expect(background).toHaveLength(1);
		const text = background[0]?.text ?? "";
		expect(text).toContain("### Precheck found (health.recovery):");
		expect(
			text.endsWith(
				"### Precheck found (health.recovery):\nHRV 31 ms, 40% under the 14-day mean",
			),
		).toBe(true);
		expect(text).toContain(schedule.prompt);
		expect((await store.get(schedule.id))?.lastStatus).toBe(
			"woken by precheck; ran",
		);
	});

	test("a throw or a timeout starts the turn with the error", async () => {
		const prechecks = fakePrechecks(
			fakePrecheck("health.recovery", new Error("the ring has not synced")),
			fakePrecheck("health.sleep", () => new Promise(() => undefined), {
				timeoutMs: 20,
			}),
		);
		await daily(prechecks, "health.recovery");
		await callScheduleTool(ctx(prechecks), "schedule_create", {
			title: "sleep",
			prompt: "review sleep",
			time: "09:30",
			precheck: "health.sleep",
		});
		const recorded = recordingLogger();
		const { scheduler, turns, notes } = harness(prechecks, recorded.logger);
		await scheduler.tick();
		await scheduler.idle();
		expect(notes).toEqual([]);
		// Logged as warnings: an error line would also wake the ops agent for the same failure.
		expect(
			recorded.lines
				.filter((line) => line.fields.precheck)
				.map((line) => [line.level, line.fields.precheck])
				.sort(),
		).toEqual([
			["warn", "health.recovery"],
			["warn", "health.sleep"],
		]);
		const findings = Object.fromEntries(
			turns.map((t) => [t.schedule.title, t.finding]),
		);
		expect(findings).toEqual({
			recovery: {
				precheck: "health.recovery",
				error: "it threw: the ring has not synced",
			},
			sleep: {
				precheck: "health.sleep",
				error: "it did not answer within 0.02 seconds",
			},
		});
		const recovery = turns.find((t) => t.schedule.title === "recovery");
		if (!recovery?.finding) throw new Error("missing turn");
		const text = scheduledTurnText(
			recovery.schedule,
			taipei("2026-09-27 09:30"),
			recovery.finding,
		);
		expect(text).toContain("### Precheck failed: health.recovery");
		expect(text).toContain("it threw: the ring has not synced");
		const statuses = (await store.forChannel("discord:a")).map(
			(s) => s.lastStatus,
		);
		expect(statuses).toContain(
			"precheck failed (it threw: the ring has not synced), woke; ran",
		);
	});

	test("a precheck no longer registered fails like a throw, so the turn still runs", async () => {
		const schedule = await daily(
			fakePrechecks(fakePrecheck("health.recovery", { wake: false })),
			"health.recovery",
		);
		const { scheduler, turns } = harness(fakePrechecks());
		await scheduler.tick();
		await scheduler.idle();
		expect(turns.map((t) => t.finding)).toEqual([
			{
				precheck: "health.recovery",
				error: "no precheck of that name is registered",
			},
		]);
		expect(turns[0]?.schedule.id).toBe(schedule.id);
	});

	test("a schedule without a precheck runs as before, with no finding", async () => {
		const prechecks = fakePrechecks(
			fakePrecheck("health.recovery", { wake: false }),
		);
		const schedule = await daily(prechecks);
		expect(schedule.precheck).toBeUndefined();
		const { scheduler, turns, notes } = harness(prechecks);
		await scheduler.tick();
		await scheduler.idle();
		expect(turns).toEqual([{ schedule }]);
		expect(notes).toEqual([]);
		expect((await store.get(schedule.id))?.lastStatus).toBe("ran");
		expect(
			scheduledTurnText(schedule, taipei("2026-09-27 09:30")).endsWith(
				schedule.prompt,
			),
		).toBe(true);
	});

	test("an unknown precheck is refused on create and on update, with the registered names", async () => {
		const prechecks = fakePrechecks(
			fakePrecheck("health.recovery", { wake: false }),
			fakePrecheck("health.sleep", { wake: false }),
		);
		await expect(
			callScheduleTool(ctx(prechecks), "schedule_create", {
				title: "recovery",
				prompt: "p",
				time: "09:30",
				precheck: "health.mood",
			}),
		).rejects.toThrow(
			new ScheduleError(
				'there is no precheck "health.mood"; the registered ones are health.recovery, health.sleep',
			),
		);
		expect(await store.forChannel("discord:a")).toEqual([]);
		const schedule = await daily(prechecks);
		await expect(
			callScheduleTool(ctx(prechecks), "schedule_update", {
				id: schedule.id,
				precheck: "health.mood",
			}),
		).rejects.toThrow("the registered ones are health.recovery, health.sleep");
		// A host without prechecks refuses any name.
		await expect(
			callScheduleTool(ctx(), "schedule_update", {
				id: schedule.id,
				precheck: "health.recovery",
			}),
		).rejects.toThrow("this host registers none");
		expect((await store.get(schedule.id))?.precheck).toBeUndefined();
	});

	test("update attaches a precheck, keeps it through other changes, and null clears it", async () => {
		const prechecks = fakePrechecks(
			fakePrecheck("health.recovery", { wake: false }),
		);
		const schedule = await daily(prechecks);
		expect(
			await callScheduleTool(ctx(prechecks), "schedule_update", {
				id: schedule.id,
				precheck: "health.recovery",
			}),
		).toContain("precheck health.recovery runs first");
		await callScheduleTool(ctx(prechecks), "schedule_update", {
			id: schedule.id,
			title: "renamed",
		});
		expect((await store.get(schedule.id))?.precheck).toBe("health.recovery");
		await callScheduleTool(ctx(prechecks), "schedule_update", {
			id: schedule.id,
			precheck: null,
		});
		expect((await store.get(schedule.id))?.precheck).toBeUndefined();
		expect((await store.get(schedule.id))?.title).toBe("renamed");
	});

	test("a lower tier cannot attach a precheck to a higher tier's schedule", async () => {
		const prechecks = fakePrechecks(
			fakePrecheck("health.recovery", { wake: false }),
		);
		await callScheduleTool(
			ctx(prechecks, {
				author: { principalId: "u2", id: "u2", name: "Ada", tier: "admin" },
			}),
			"schedule_create",
			{ title: "patrol", prompt: "p", time: "09:30" },
		);
		const [schedule] = await store.forChannel("discord:a");
		await expect(
			callScheduleTool(
				ctx(prechecks, {
					author: { principalId: "u3", id: "u3", name: "Max", tier: "member" },
				}),
				"schedule_update",
				{ id: schedule?.id, precheck: "health.recovery" },
			),
		).rejects.toThrow(/higher tier/);
	});

	test("schedule_list names the prechecks there are, with their descriptions", async () => {
		const prechecks = fakePrechecks(
			fakePrecheck(
				"health.recovery",
				{ wake: false },
				{ description: "Wakes you when last night's recovery is off." },
			),
		);
		const empty = await callScheduleTool(ctx(prechecks), "schedule_list", {});
		expect(empty).toContain("This channel has no schedules.");
		expect(empty).toContain(
			"- health.recovery: Wakes you when last night's recovery is off.",
		);
		expect(await callScheduleTool(ctx(), "schedule_list", {})).toBe(
			"This channel has no schedules.",
		);
	});
});

describeDb("the precheck migration", () => {
	test("adds the precheck and precheck script columns to an existing schedules table, its rows without either", async () => {
		const sql = new SQL(testDatabaseUrl);
		try {
			await sql`DROP TABLE IF EXISTS schedules`;
			// The table as a database from before prechecks has it.
			await migrate(sql, [PgScheduleStore.migration]);
			await sql`
				INSERT INTO schedules (channel_key, mode, title, prompt, recurrence, next_run,
					created_by_id, created_by_name)
				VALUES ('discord:a', 'owner', 'old', 'p', ${JSON.stringify({ kind: "every", time: "09:30", everyDays: 1, startDate: "2026-09-01" })},
					now(), 'u1', 'Sam')`;
			const before: unknown[] = await sql`
				SELECT 1 FROM information_schema.columns
				WHERE table_name = 'schedules' AND column_name = 'precheck'`;
			expect(before).toEqual([]);
			await migrate(sql, PgScheduleStore.migrations());
			const store = await PgScheduleStore.attach(sql);
			const [old] = await store.forChannel("discord:a");
			expect(old?.title).toBe("old");
			expect(old?.precheck).toBeUndefined();
			expect(old?.precheckScript).toBeUndefined();
			if (!old) throw new Error("missing row");
			await store.update("discord:a", old.id, {
				precheckScript: "export default () => ({ wake: true, context: 'x' })",
				precheckTools: [],
			});
			expect((await store.get(old.id))?.precheckTools).toEqual([]);
			expect((await store.get(old.id))?.precheckScript).toContain(
				"export default",
			);
			await store.update("discord:a", old.id, { precheckScript: null });
			await store.update("discord:a", old.id, { precheck: "health.recovery" });
			expect((await store.get(old.id))?.precheck).toBe("health.recovery");
			// Running it again changes nothing.
			await migrate(sql, PgScheduleStore.migrations());
			expect((await store.get(old.id))?.precheck).toBe("health.recovery");
		} finally {
			// Leave the table as a migrated host has it: the ledger of the host tests records it as made.
			await sql`DROP TABLE IF EXISTS schedules`;
			await migrate(sql, PgScheduleStore.migrations());
			await sql.close();
		}
	});

	test("adds the precheck tools column to a database with scripts, which keep theirs without tools", async () => {
		const sql = new SQL(testDatabaseUrl);
		try {
			await sql`DROP TABLE IF EXISTS schedules`;
			// The table as 0.7.11 left it: scripts, but no record of their tools.
			const migrations = PgScheduleStore.migrations();
			await migrate(
				sql,
				migrations.filter((m) => m.name !== "schedules-precheck-tools"),
			);
			await sql`
				INSERT INTO schedules (channel_key, mode, title, prompt, recurrence, next_run,
					created_by_id, created_by_name, precheck_script)
				VALUES ('discord:a', 'owner', 'old', 'p', ${JSON.stringify({ kind: "every", time: "09:30", everyDays: 1, startDate: "2026-09-01" })},
					now(), 'u1', 'Sam', 'export default () => ({ wake: false })')`;
			await migrate(sql, migrations);
			const store = await PgScheduleStore.attach(sql);
			const [old] = await store.forChannel("discord:a");
			if (!old) throw new Error("missing row");
			expect(old.precheckScript).toBe("export default () => ({ wake: false })");
			expect(old.precheckTools).toBeUndefined();
			// A change that keeps the script keeps it without tools; saving it again records them.
			await store.update("discord:a", old.id, { title: "renamed" });
			expect((await store.get(old.id))?.precheckTools).toBeUndefined();
			await store.update("discord:a", old.id, {
				precheckScript: "export default () => ({ wake: false })",
				precheckTools: [{ server: "health", tool: "garmin-get-hrv" }],
			});
			expect((await store.get(old.id))?.precheckTools).toEqual([
				{ server: "health", tool: "garmin-get-hrv" },
			]);
		} finally {
			// Leave the table as a migrated host has it: the ledger of the host tests records it as made.
			await sql`DROP TABLE IF EXISTS schedules`;
			await migrate(sql, PgScheduleStore.migrations());
			await sql.close();
		}
	});
});
