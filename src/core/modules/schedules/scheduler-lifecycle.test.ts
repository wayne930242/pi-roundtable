import { describe, expect, test } from "bun:test";
import { silentLogger } from "../../log.ts";
import { runsAsCreator } from "../../testing/background.ts";
import type { Schedule } from "./schedule-store.ts";
import { Scheduler } from "./scheduler.ts";

const now = new Date("2026-10-01T10:00:00Z");
function schedule(id = 1): Schedule {
	return {
		id,
		channel: "discord:test",
		target: "owner",
		title: "daily",
		prompt: "report",
		recurrence: {
			kind: "every",
			time: "10:00",
			everyDays: 1,
			startDate: "2026-10-01",
		},
		nextRun: now,
		createdById: "owner",
		createdByName: "Owner",
		createdTier: "owner",
		createdAt: now,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("scheduler shutdown races", () => {
	test("lets an already running turn finish while stopping new work", async () => {
		const answer = deferred<{ status: "ran" }>();
		const statuses: string[] = [];
		let runs = 0;
		const scheduler = new Scheduler({
			store: {
				due: async () => [schedule()],
				claim: async () => true,
				recordStatus: async (_id, status) => {
					statuses.push(status);
				},
			},
			runner: {
				runsAs: runsAsCreator,
				runScheduled: () => {
					runs += 1;
					return answer.promise;
				},
			},
			logger: silentLogger(),
			now: () => now,
		});
		await scheduler.tick();
		await scheduler.stop();
		await scheduler.tick();
		expect(runs).toBe(1);
		expect(statuses).toEqual([]);
		answer.resolve({ status: "ran" });
		await scheduler.idle();
		expect(statuses).toEqual(["ran"]);
	});

	test("does not claim schedules when stopped during the due query", async () => {
		const due = deferred<Schedule[]>();
		let claims = 0;
		let runs = 0;
		const scheduler = new Scheduler({
			store: {
				due: () => due.promise,
				claim: async () => {
					claims += 1;
					return true;
				},
				recordStatus: async () => {},
			},
			runner: {
				runsAs: runsAsCreator,
				runScheduled: async () => {
					runs += 1;
					return { status: "ran" };
				},
			},
			logger: silentLogger(),
			now: () => now,
		});
		const tick = scheduler.tick();
		await scheduler.stop();
		due.resolve([schedule()]);
		await tick;
		await scheduler.idle();
		expect(claims).toBe(0);
		expect(runs).toBe(0);
	});

	test("records a claimed run as skipped when stopped during its claim", async () => {
		const claim = deferred<boolean>();
		const claiming = deferred<void>();
		const statuses: string[] = [];
		let claims = 0;
		let runs = 0;
		let prechecks = 0;
		const scheduler = new Scheduler({
			store: {
				due: async () => [{ ...schedule(), precheck: "sensor" }, schedule(2)],
				claim: () => {
					claims += 1;
					claiming.resolve();
					return claim.promise;
				},
				recordStatus: async (_id, status) => {
					statuses.push(status);
				},
			},
			prechecks: {
				get: () => {
					prechecks += 1;
					return undefined;
				},
			},
			runner: {
				runsAs: runsAsCreator,
				runScheduled: async () => {
					runs += 1;
					return { status: "ran" };
				},
			},
			logger: silentLogger(),
			now: () => now,
		});
		const tick = scheduler.tick();
		await claiming.promise;
		await scheduler.stop();
		claim.resolve(true);
		await tick;
		await scheduler.idle();
		expect(claims).toBe(1);
		expect(runs).toBe(0);
		expect(prechecks).toBe(0);
		expect(statuses).toEqual(["skipped: the host stopped before its run"]);
	});

	test("claims nothing while the host drains, so a due run stays due for the next start", async () => {
		let draining = false;
		let claims = 0;
		let runs = 0;
		const scheduler = new Scheduler({
			store: {
				due: async () => [schedule()],
				claim: async () => {
					claims += 1;
					return true;
				},
				recordStatus: async () => {},
			},
			runner: {
				runsAs: runsAsCreator,
				runScheduled: async () => {
					runs += 1;
					return { status: "ran" };
				},
			},
			draining: () => draining,
			logger: silentLogger(),
			now: () => now,
		});
		draining = true;
		await scheduler.tick();
		await scheduler.idle();
		expect([claims, runs]).toEqual([0, 0]);
		draining = false;
		await scheduler.tick();
		await scheduler.idle();
		expect([claims, runs]).toEqual([1, 1]);
	});

	test("claims no further schedule once the drain begins during a check", async () => {
		let draining = false;
		const claimed: number[] = [];
		const scheduler = new Scheduler({
			store: {
				due: async () => [schedule(1), schedule(2)],
				claim: async (due) => {
					claimed.push(due.id);
					draining = true;
					return true;
				},
				recordStatus: async () => {},
			},
			runner: {
				runsAs: runsAsCreator,
				runScheduled: async () => ({ status: "ran" }),
			},
			draining: () => draining,
			logger: silentLogger(),
			now: () => now,
		});
		await scheduler.tick();
		await scheduler.idle();
		expect(claimed).toEqual([1]);
	});
});
