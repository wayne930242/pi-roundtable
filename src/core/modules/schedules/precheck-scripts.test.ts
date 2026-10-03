import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { SQL } from "bun";
import type { TSchema } from "typebox";
import type { BackgroundTarget } from "../../contract/channels.ts";
import { PluginError } from "../../errors.ts";
import { silentLogger } from "../../log.ts";
import { scheduleToolSpecs } from "../../shared/schedule-tools.ts";
import {
	describeDb,
	openTestStore,
	type TestStore,
	testDatabaseUrl,
} from "../../testing/database.ts";
import { useTestLocale } from "../../testing/locale.ts";
import {
	fakePrecheck,
	fakePrechecks,
	fakeScriptRunner,
} from "../../testing/prechecks.ts";
import { setTimeZone } from "../../time.ts";
import {
	checkPrecheckScript,
	PRECHECK_SCRIPT_CHARS,
	type PrecheckFinding,
	type PrecheckRegistry,
	type PrecheckScriptRunner,
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

const SCRIPT = `export default async ({ mcp, today }) => {
	const hrv = await mcp.json("health", "garmin-get-hrv", { date: today });
	return hrv.lastNightAvg < 26 ? { wake: true, context: "HRV low" } : { wake: false };
};`;

beforeAll(() => setTimeZone("Asia/Taipei"));
afterAll(useTestLocale);

/** Registers the given runner on a registry with one named precheck. */
function withRunner(runner?: PrecheckScriptRunner): PrecheckRegistry {
	const registry = fakePrechecks(
		fakePrecheck("health.recovery", { wake: false }),
	);
	if (runner) registry.useScriptRunner(runner);
	return registry;
}

describe("precheck scripts without running them", () => {
	test("a script must parse as a module with a default export, within the limit", () => {
		expect(checkPrecheckScript(SCRIPT)).toBe(SCRIPT);
		const renamed =
			"const check = () => ({ wake: false });\nexport { check as default };";
		expect(checkPrecheckScript(renamed)).toBe(renamed);
		expect(() => checkPrecheckScript("export default (")).toThrow(
			"does not parse as a JavaScript module",
		);
		expect(() =>
			checkPrecheckScript("export const check = () => ({ wake: false });"),
		).toThrow("needs a default export");
		expect(() =>
			checkPrecheckScript(
				`export default () => ({ wake: false }); //${"x".repeat(PRECHECK_SCRIPT_CHARS)}`,
			),
		).toThrow(`keep it within ${PRECHECK_SCRIPT_CHARS}`);
		expect(() => checkPrecheckScript(" ")).toThrow("default export");
	});

	test("checking a script never runs it in this process", () => {
		const probe = globalThis as { precheckScriptRan?: boolean };
		checkPrecheckScript(
			"globalThis.precheckScriptRan = true; export default () => ({ wake: false });",
		);
		expect(probe.precheckScriptRan).toBeUndefined();
	});

	test("the registry takes one runner, with run and describe", () => {
		const registry = withRunner();
		expect(registry.scriptRunner()).toBeUndefined();
		const runner = fakeScriptRunner({ wake: false });
		registry.useScriptRunner(runner);
		expect(registry.scriptRunner()).toBe(runner);
		expect(() =>
			registry.useScriptRunner(fakeScriptRunner({ wake: false })),
		).toThrow(PluginError);
		expect(() =>
			withRunner().useScriptRunner({
				run: () => ({ wake: false }),
			} as unknown as PrecheckScriptRunner),
		).toThrow(PluginError);
	});

	test("the tools take and mention precheck_script only where a runner runs scripts", () => {
		const params = (precheckScripts: boolean) =>
			Object.fromEntries(
				scheduleToolSpecs({
					locale: "en",
					timeZone: "UTC",
					precheckScripts,
				}).map((spec) => [
					spec.name,
					Object.keys(
						(spec.parameters as TSchema & { properties: object }).properties,
					),
				]),
			);
		expect(params(false).schedule_create).not.toContain("precheck_script");
		expect(params(false).schedule_update).not.toContain("precheck_script");
		expect(params(true).schedule_create).toContain("precheck_script");
		expect(params(true).schedule_update).toContain("precheck_script");
	});
});

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("precheck scripts over PostgreSQL", () => {
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

	const ctx = (
		prechecks: PrecheckRegistry,
		over: Partial<ScheduleToolContext> = {},
	): ScheduleToolContext => ({
		store,
		channel: "discord:health",
		target: OPEN,
		author: { id: "u1", name: "Sam" },
		now: taipei("2026-09-26 23:30"),
		prechecks,
		...over,
	});

	async function scripted(prechecks: PrecheckRegistry): Promise<Schedule> {
		await callScheduleTool(ctx(prechecks), "schedule_create", {
			title: "recovery",
			prompt: "check last night's recovery",
			time: "09:30",
			precheck_script: SCRIPT,
		});
		const [schedule] = await store.forChannel("discord:health");
		if (!schedule) throw new Error("missing schedule");
		return schedule;
	}

	function harness(prechecks: PrecheckRegistry) {
		const turns: { schedule: Schedule; finding?: PrecheckFinding }[] = [];
		const notes: string[] = [];
		const scheduler = new Scheduler({
			store,
			prechecks,
			runner: {
				runScheduled: async (schedule, _firedAt, finding) => {
					turns.push({ schedule, ...(finding ? { finding } : {}) });
					return { status: "ran" };
				},
			},
			notify: async (_schedule, note) => {
				notes.push(note);
			},
			logger: silentLogger(),
			now: () => taipei("2026-09-27 09:30"),
		});
		return { scheduler, turns, notes };
	}

	test("without a runner a script is refused, naming the registered prechecks, and schedule_list does not offer scripts", async () => {
		const prechecks = withRunner();
		await expect(
			callScheduleTool(ctx(prechecks), "schedule_create", {
				title: "recovery",
				prompt: "p",
				time: "09:30",
				precheck_script: SCRIPT,
			}),
		).rejects.toThrow(
			"this host runs no precheck scripts; attach a registered precheck instead: health.recovery",
		);
		expect(await store.forChannel("discord:health")).toEqual([]);
		const listed = await callScheduleTool(ctx(prechecks), "schedule_list", {});
		expect(listed).not.toContain("precheck_script");
	});

	test("the runner runs the stored script with the host's zone and its date there, and its answer decides the turn", async () => {
		const runner = fakeScriptRunner((_script, context) =>
			context.today === "2026-09-27"
				? { wake: false, note: "recovery normal" }
				: { wake: true, context: `wrong date ${context.today}` },
		);
		const prechecks = withRunner(runner);
		const schedule = await scripted(prechecks);
		expect(schedule.precheckScript).toBe(SCRIPT);
		const { scheduler, turns, notes } = harness(prechecks);
		await scheduler.tick();
		await scheduler.idle();
		expect(runner.calls.map((call) => call.script)).toEqual([SCRIPT]);
		expect(runner.calls[0]?.context.timeZone).toBe("Asia/Taipei");
		expect(runner.calls[0]?.context.schedule.id).toBe(schedule.id);
		expect(turns).toEqual([]);
		expect(notes).toEqual(["recovery normal"]);
		expect((await store.get(schedule.id))?.lastStatus).toBe(
			"skipped by precheck (recovery normal)",
		);
	});

	test("a waking script's context reaches the turn under the script's heading", async () => {
		const prechecks = withRunner(
			fakeScriptRunner({ wake: true, context: "HRV 22 ms, under 26" }),
		);
		const schedule = await scripted(prechecks);
		const { scheduler, turns } = harness(prechecks);
		await scheduler.tick();
		await scheduler.idle();
		expect(turns.map((t) => t.finding)).toEqual([
			{ precheck: "script", context: "HRV 22 ms, under 26" },
		]);
		const text = scheduledTurnText(
			schedule,
			taipei("2026-09-27 09:30"),
			turns[0]?.finding,
		);
		expect(text).toContain("### Precheck found (script):\nHRV 22 ms, under 26");
	});

	test("a throwing script, a timeout, and a missing runner all wake the turn with the error", async () => {
		const throwing = withRunner(
			fakeScriptRunner(new Error("garmin-login failed")),
		);
		await scripted(throwing);
		const first = harness(throwing);
		await first.scheduler.tick();
		await first.scheduler.idle();
		expect(first.turns.map((t) => t.finding)).toEqual([
			{ precheck: "script", error: "it threw: garmin-login failed" },
		]);

		await store.remove((await store.forChannel("discord:health"))[0]?.id ?? 0);
		const slow = withRunner(
			fakeScriptRunner(() => new Promise(() => undefined), { timeoutMs: 20 }),
		);
		await scripted(slow);
		const second = harness(slow);
		await second.scheduler.tick();
		await second.scheduler.idle();
		expect(second.turns.map((t) => t.finding)).toEqual([
			{ precheck: "script", error: "it did not answer within 0.02 seconds" },
		]);

		// The sandbox was removed after the script was stored: the turn runs, never a silent skip.
		const gone = harness(withRunner());
		await store.update(
			"discord:health",
			(await store.forChannel("discord:health"))[0]?.id ?? 0,
			{ nextRun: taipei("2026-09-27 09:30") },
		);
		await gone.scheduler.tick();
		await gone.scheduler.idle();
		expect(gone.turns.map((t) => t.finding)).toEqual([
			{
				precheck: "script",
				error:
					"this host has no precheck script runner, so the script did not run",
			},
		]);
	});

	test("a schedule has a name or a script: both are refused, and setting one removes the other", async () => {
		const prechecks = withRunner(fakeScriptRunner({ wake: false }));
		await expect(
			callScheduleTool(ctx(prechecks), "schedule_create", {
				title: "recovery",
				prompt: "p",
				time: "09:30",
				precheck: "health.recovery",
				precheck_script: SCRIPT,
			}),
		).rejects.toThrow("give precheck or precheck_script, not both");
		const schedule = await scripted(prechecks);
		await callScheduleTool(ctx(prechecks), "schedule_update", {
			id: schedule.id,
			precheck: "health.recovery",
		});
		let after = await store.get(schedule.id);
		expect([after?.precheck, after?.precheckScript]).toEqual([
			"health.recovery",
			undefined,
		]);
		await callScheduleTool(ctx(prechecks), "schedule_update", {
			id: schedule.id,
			precheck_script: SCRIPT,
		});
		after = await store.get(schedule.id);
		expect([after?.precheck, after?.precheckScript]).toEqual([
			undefined,
			SCRIPT,
		]);
		await expect(
			callScheduleTool(ctx(prechecks), "schedule_update", {
				id: schedule.id,
				precheck_script: "export const x = 1;",
			}),
		).rejects.toThrow("needs a default export");
		await callScheduleTool(ctx(prechecks), "schedule_update", {
			id: schedule.id,
			precheck_script: null,
		});
		after = await store.get(schedule.id);
		expect([after?.precheck, after?.precheckScript]).toEqual([
			undefined,
			undefined,
		]);
	});

	test("schedule_list shows a schedule's script, and the runner's guide for this channel", async () => {
		const prechecks = withRunner(
			fakeScriptRunner(
				{ wake: false },
				{
					describe: (scope) =>
						`Scripts here may call health: garmin-get-hrv (${scope.channel}, ${scope.target}).`,
				},
			),
		);
		const schedule = await scripted(prechecks);
		const listed = await callScheduleTool(ctx(prechecks), "schedule_list", {});
		expect(listed).toContain(`precheck script (${SCRIPT.length} characters)`);
		expect(listed).toContain("You can write a precheck of your own instead");
		expect(listed).toContain(
			"Scripts here may call health: garmin-get-hrv (discord:health, open).",
		);
		const one = await callScheduleTool(ctx(prechecks), "schedule_list", {
			id: schedule.id,
		});
		expect(one.endsWith(`Precheck script:\n${SCRIPT}`)).toBe(true);
	});

	test("schedule_list still answers when the runner cannot describe this channel", async () => {
		const prechecks = withRunner({
			...fakeScriptRunner({ wake: false }),
			describe: () => {
				throw new Error("no agent owns this channel");
			},
		});
		expect(
			await callScheduleTool(ctx(prechecks), "schedule_list", {}),
		).toContain(
			"The host could not say what a script may call here (no agent owns this channel)",
		);
	});

	test("schedule_list does not wait on a runner that never says what a script may call", async () => {
		const prechecks = withRunner({
			...fakeScriptRunner({ wake: false }),
			describe: () => new Promise<string>(() => {}),
		});
		expect(
			await callScheduleTool(ctx(prechecks), "schedule_list", {}),
		).toContain(
			"The host could not say what a script may call here (it did not answer in time)",
		);
	}, 15_000);

	test("the runner learns the asker's tier when it describes, so it may grant lower tiers less", async () => {
		const scopes: unknown[] = [];
		const prechecks = withRunner({
			...fakeScriptRunner({ wake: false }),
			describe: (scope) => {
				scopes.push(scope);
				return "none";
			},
		});
		await callScheduleTool(
			ctx(prechecks, { author: { id: "u2", name: "Kim", tier: "member" } }),
			"schedule_list",
			{},
		);
		expect(scopes).toEqual([
			{ channel: "discord:health", target: "open", tier: "member" },
		]);
	});

	test("the store itself keeps a name and a script apart", async () => {
		const base = {
			channel: "discord:health" as const,
			target: "open",
			title: "recovery",
			prompt: "p",
			recurrence: {
				kind: "every" as const,
				time: "09:30",
				everyDays: 1,
				startDate: "2026-09-27",
			},
			nextRun: taipei("2026-09-27 09:30"),
			createdById: "u1",
			createdByName: "Sam",
			createdTier: "owner" as const,
		};
		await expect(
			store.create({
				...base,
				precheck: "health.recovery",
				precheckScript: SCRIPT,
			}),
		).rejects.toThrow("not both");
		const created = await store.create({ ...base, precheckScript: SCRIPT });
		const named = await store.update("discord:health", created.id, {
			precheck: "health.recovery",
		});
		expect([named?.precheck, named?.precheckScript]).toEqual([
			"health.recovery",
			undefined,
		]);
		const scripted = await store.update("discord:health", created.id, {
			precheckScript: SCRIPT,
		});
		expect([scripted?.precheck, scripted?.precheckScript]).toEqual([
			undefined,
			SCRIPT,
		]);
	});

	test("stopping the scheduler aborts a running script, waits for its cleanup, and starts no turn", async () => {
		let cleaned = false;
		let started = () => {};
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		const prechecks = withRunner(
			fakeScriptRunner(
				(_script, context) =>
					new Promise((_resolve, reject) => {
						started();
						context.signal.addEventListener("abort", () => {
							// The sandbox removes its container after the abort, before it settles.
							setTimeout(() => {
								cleaned = true;
								reject(new Error("aborted"));
							}, 50);
						});
					}),
			),
		);
		const schedule = await scripted(prechecks);
		const { scheduler, turns } = harness(prechecks);
		await scheduler.tick();
		await running;
		await scheduler.stop();
		expect(cleaned).toBe(true);
		await scheduler.idle();
		expect(turns).toEqual([]);
		expect((await store.get(schedule.id))?.lastStatus).toBe(
			"skipped: the host stopped during its precheck",
		);
	});

	test("a lower tier cannot attach a script to a higher tier's schedule", async () => {
		const prechecks = withRunner(fakeScriptRunner({ wake: false }));
		await callScheduleTool(
			ctx(prechecks, { author: { id: "u2", name: "Ada", tier: "admin" } }),
			"schedule_create",
			{ title: "patrol", prompt: "p", time: "09:30" },
		);
		const [schedule] = await store.forChannel("discord:health");
		await expect(
			callScheduleTool(
				ctx(prechecks, { author: { id: "u3", name: "Max", tier: "member" } }),
				"schedule_update",
				{ id: schedule?.id, precheck_script: SCRIPT },
			),
		).rejects.toThrow(/higher tier/);
	});
});
