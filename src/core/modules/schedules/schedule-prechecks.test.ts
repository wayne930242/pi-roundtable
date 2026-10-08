import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { HoldCheck } from "../../holds.ts";
import { silentLogger } from "../../log.ts";
import { runsAsCreator } from "../../testing/background.ts";
import { useTestLocale } from "../../testing/locale.ts";
import {
	fakePrecheck,
	fakePrechecks,
	fakeScriptRunner,
} from "../../testing/prechecks.ts";
import type { PrecheckRegistry } from "./prechecks.ts";
import type { Schedule } from "./schedule-store.ts";
import { type ScheduledRunner, Scheduler } from "./scheduler.ts";

const now = new Date("2026-10-01T10:00:00Z");
const script = `export default async ({ mcp }) => {
	await mcp.json("health", "garmin-get-hrv", { days: 1 });
	await mcp.call("weather", "forecast");
	return { wake: true, context: "ready" };
};`;

beforeAll(() => useTestLocale({ timeZone: "Asia/Taipei" }));
afterAll(useTestLocale);

function schedule(id: number, change: Partial<Schedule> = {}): Schedule {
	return {
		id,
		channel: "discord:test",
		target: "owner",
		title: `daily ${id}`,
		prompt: "report",
		recurrence: {
			kind: "every",
			time: "18:00",
			everyDays: 1,
			startDate: "2026-10-01",
		},
		nextRun: now,
		createdById: "owner",
		createdByName: "Owner",
		createdTier: "owner",
		createdAt: now,
		...change,
	};
}

function harness(options: {
	schedules: Schedule[];
	prechecks?: Pick<PrecheckRegistry, "get"> &
		Partial<Pick<PrecheckRegistry, "scriptRunner">>;
	holds?: () => HoldCheck;
	runner?: ScheduledRunner;
}) {
	const statuses: { id: number; status: string }[] = [];
	const notes: { id: number; note: string }[] = [];
	const runs: { schedule: Schedule; finding: unknown }[] = [];
	const scheduler = new Scheduler({
		store: {
			due: async () => options.schedules,
			claim: async () => true,
			recordStatus: async (id, status) => {
				statuses.push({ id, status });
			},
		},
		prechecks: options.prechecks,
		holds: options.holds,
		notify: async (given, note) => {
			notes.push({ id: given.id, note });
		},
		runner: options.runner ?? {
			runsAs: runsAsCreator,
			runScheduled: async (given, _firedAt, finding) => {
				runs.push({ schedule: given, finding });
				return { status: "ran" };
			},
		},
		logger: silentLogger(),
		now: () => now,
	});
	return { scheduler, statuses, notes, runs };
}

async function runScheduler(h: ReturnType<typeof harness>) {
	await h.scheduler.tick();
	await h.scheduler.idle();
}

describe("scheduler precheck behavior", () => {
	test("a creator who may not run the turn runs no precheck: the run is skipped, saying why, with no note", async () => {
		const precheck = fakePrecheck("health.wake", {
			wake: false,
			note: "nothing to say",
		});
		const runs: Schedule[] = [];
		const h = harness({
			prechecks: fakePrechecks(precheck),
			schedules: [
				schedule(1, { precheck: "health.wake" }),
				schedule(2, { precheck: "health.wake", createdById: "lost" }),
			],
			runner: {
				runsAs: async (given) => {
					if (given.id === 1) return { skipped: "principal owner is disabled" };
					throw new Error("the database is down");
				},
				runScheduled: async (given) => {
					runs.push(given);
					return { status: "ran" };
				},
			},
		});
		await runScheduler(h);
		expect(precheck.calls).toEqual([]);
		expect(runs).toEqual([]);
		expect(h.notes).toEqual([]);
		expect(h.statuses).toEqual([
			{ id: 1, status: "skipped: principal owner is disabled" },
			{
				id: 2,
				status:
					"skipped: whom it runs as could not be checked (the database is down)",
			},
		]);
	});

	test("a precheck runs at the tier the run is for, not the one the schedule was set at", async () => {
		const precheck = fakePrecheck("health.wake", { wake: false });
		const h = harness({
			prechecks: fakePrechecks(precheck),
			schedules: [schedule(1, { precheck: "health.wake" })],
			runner: {
				runsAs: async (given) => ({
					speaker: {
						id: given.createdById,
						name: given.createdByName,
						tier: "admin",
						principalId: given.createdById,
					},
				}),
				runScheduled: async () => ({ status: "ran" }),
			},
		});
		await runScheduler(h);
		expect(precheck.calls.map((call) => call.tier)).toEqual(["admin"]);
	});

	test("a host that stops while whom a schedule runs as is checked runs no precheck", async () => {
		const precheck = fakePrecheck("health.wake", { wake: true, context: "x" });
		const { promise: asked, resolve: ask } = Promise.withResolvers<void>();
		const { promise: checked, resolve: check } = Promise.withResolvers<void>();
		const h = harness({
			prechecks: fakePrechecks(precheck),
			schedules: [schedule(1, { precheck: "health.wake" })],
			runner: {
				runsAs: async (given) => {
					ask();
					await checked;
					return runsAsCreator(given);
				},
				runScheduled: async () => ({ status: "ran" }),
			},
		});
		await h.scheduler.tick();
		await asked;
		const stopping = h.scheduler.stop();
		check();
		await h.scheduler.idle();
		await stopping;
		expect(precheck.calls).toEqual([]);
		expect(h.statuses).toEqual([
			{ id: 1, status: "skipped: the host stopped before its run" },
		]);
	});

	test("registered prechecks skip, wake, and fail with existing statuses", async () => {
		const prechecks = fakePrechecks(
			fakePrecheck("health.skip", { wake: false, note: "recovery normal" }),
			fakePrecheck("health.wake", { wake: true, context: "HRV low" }),
			fakePrecheck("health.fail", new Error("sensor offline")),
		);
		const h = harness({
			prechecks,
			schedules: [
				schedule(1, { precheck: "health.skip" }),
				schedule(2, { precheck: "health.wake" }),
				schedule(3, { precheck: "health.fail" }),
			],
		});
		await runScheduler(h);

		expect(h.notes).toEqual([{ id: 1, note: "recovery normal" }]);
		expect(h.runs.map((run) => [run.schedule.id, run.finding])).toEqual([
			[2, { precheck: "health.wake", context: "HRV low" }],
			[3, { precheck: "health.fail", error: "it threw: sensor offline" }],
		]);
		expect(h.statuses).toEqual([
			{ id: 1, status: "skipped by precheck (recovery normal)" },
			{ id: 2, status: "woken by precheck; ran" },
			{
				id: 3,
				status: "precheck failed (it threw: sensor offline), woke; ran",
			},
		]);
	});

	test("missing registered prechecks and missing script runners wake with the same errors", async () => {
		const h = harness({
			prechecks: fakePrechecks(),
			schedules: [
				schedule(1, { precheck: "health.missing" }),
				schedule(2, { precheckScript: script, precheckTools: [] }),
			],
		});
		await runScheduler(h);

		expect(h.runs.map((run) => run.finding)).toEqual([
			{
				precheck: "health.missing",
				error: "no precheck of that name is registered",
			},
			{
				precheck: "script",
				error:
					"this host has no precheck script runner, so the script did not run",
			},
		]);
		expect(h.statuses.map(({ status }) => status)).toEqual([
			"precheck failed (no precheck of that name is registered), woke; ran",
			"precheck failed (this host has no precheck script runner, so the script did not run), woke; ran",
		]);
	});

	test("script prechecks receive local date context and approved tools", async () => {
		const runner = fakeScriptRunner({
			wake: true,
			context: "script found work",
		});
		const prechecks = fakePrechecks();
		prechecks.useScriptRunner(runner);
		const h = harness({
			prechecks,
			schedules: [
				schedule(1, {
					precheckScript: script,
					precheckTools: [
						{ server: "health", tool: "garmin-get-hrv" },
						{ server: "weather", tool: "forecast", held: "approved" },
					],
				}),
			],
		});
		await runScheduler(h);

		expect(runner.calls).toHaveLength(1);
		expect(runner.calls[0]?.script).toBe(script);
		expect(runner.calls[0]?.context.timeZone).toBe("Asia/Taipei");
		expect(runner.calls[0]?.context.today).toBe("2026-10-01");
		expect(runner.calls[0]?.context.schedule.id).toBe(1);
		expect(runner.calls[0]?.context.tools).toEqual([
			{ server: "health", tool: "garmin-get-hrv" },
			{ server: "weather", tool: "forecast" },
		]);
		expect(h.runs.map((run) => run.finding)).toEqual([
			{ precheck: "script", context: "script found work" },
		]);
		expect(h.statuses).toEqual([{ id: 1, status: "woken by precheck; ran" }]);
	});

	test("legacy scripts derive tools through hold rules and refuse held calls", async () => {
		const runner = fakeScriptRunner({ wake: false, note: "quiet" });
		const prechecks = fakePrechecks();
		prechecks.useScriptRunner(runner);
		const holds = ((tool: string) =>
			tool === "weather-forecast" ? "owner approval" : undefined) as HoldCheck;
		const h = harness({
			prechecks,
			holds: () => holds,
			schedules: [schedule(1, { precheckScript: script })],
		});
		await runScheduler(h);

		expect(runner.calls).toEqual([]);
		expect(h.runs.map((run) => run.finding)).toEqual([
			{
				precheck: "script",
				error:
					"this script was saved before its tools were recorded and calls tools that need the owner's approval (weather/forecast), so it did not run; save it again with schedule_update, so the owner can approve the tools it calls",
			},
		]);
	});

	test("legacy scripts run with derived tools when hold rules hold none", async () => {
		const runner = fakeScriptRunner({ wake: false, note: "quiet" });
		const prechecks = fakePrechecks();
		prechecks.useScriptRunner(runner);
		const holds = (() => undefined) as HoldCheck;
		const h = harness({
			prechecks,
			holds: () => holds,
			schedules: [schedule(1, { precheckScript: script })],
		});
		await runScheduler(h);

		expect(runner.calls[0]?.context.tools).toEqual([
			{ server: "health", tool: "garmin-get-hrv" },
			{ server: "weather", tool: "forecast" },
		]);
		expect(h.runs).toEqual([]);
		expect(h.statuses).toEqual([
			{ id: 1, status: "skipped by precheck (quiet)" },
		]);
	});

	test("stop waits for cleanup from a precheck that timed out", async () => {
		let cleaned = false;
		let finishCleanup = () => {};
		const timedOut = fakePrecheck(
			"health.slow",
			(context) =>
				new Promise((resolve) => {
					context.signal.addEventListener("abort", () => {
						finishCleanup = () => {
							cleaned = true;
							resolve({ wake: false, note: "late cleanup" });
						};
					});
				}),
			{ timeoutMs: 1 },
		);
		const h = harness({
			prechecks: fakePrechecks(timedOut),
			schedules: [schedule(1, { precheck: "health.slow" })],
		});

		await runScheduler(h);
		expect(h.runs.map((run) => run.finding)).toEqual([
			{
				precheck: "health.slow",
				error: "it did not answer within 0.001 seconds",
			},
		]);
		expect(cleaned).toBe(false);
		let stopped = false;
		const stopping = h.scheduler.stop().then(() => {
			stopped = true;
		});
		await Bun.sleep(0);
		expect(stopped).toBe(false);
		finishCleanup();
		await stopping;
		expect(cleaned).toBe(true);
	});

	test("stop aborts an active precheck and drains cleanup without starting a turn", async () => {
		let signal: AbortSignal | undefined;
		let finishCleanup = () => {};
		const { promise: started, resolve: start } = Promise.withResolvers<void>();
		const precheck = fakePrecheck("health.active", (context) => {
			signal = context.signal;
			start();
			return new Promise((resolve) => {
				finishCleanup = () => resolve({ wake: true, context: "too late" });
			});
		});
		const h = harness({
			prechecks: fakePrechecks(precheck),
			schedules: [schedule(1, { precheck: "health.active" })],
		});
		await h.scheduler.tick();
		// The precheck starts once whom the schedule runs as is checked.
		await started;
		let stopped = false;
		const stopping = h.scheduler.stop().then(() => {
			stopped = true;
		});
		expect(signal?.aborted).toBe(true);
		await h.scheduler.idle();
		expect(stopped).toBe(false);
		expect(h.runs).toEqual([]);
		expect(h.statuses).toEqual([
			{ id: 1, status: "skipped: the host stopped during its precheck" },
		]);
		finishCleanup();
		await stopping;
		expect(stopped).toBe(true);
	});
});
