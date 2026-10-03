import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { schedulerPlugin } from "./core/builtin/modules.ts";
import type { ChatSurface } from "./core/contract/surface.ts";
import { messages } from "./core/i18n/index.ts";
import { PgScheduleStore } from "./core/modules/schedules/schedule-store.ts";
import {
	BACKGROUND_TURNS,
	type BackgroundTurns,
	PRECHECKS,
	SCHEDULES,
	type Schedule,
} from "./index.ts";
import {
	describeDb,
	fakePrecheck,
	fakePrechecks,
	openTestStore,
	servicePair,
	type TestStore,
	testDatabaseUrl,
	testPlugin,
} from "./testing.ts";

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("the scheduler plugin with a precheck", () => {
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

	test("posts the skipping precheck's note through the channel's surface and starts no turn", async () => {
		const prechecks = fakePrechecks(
			fakePrecheck("health.recovery", {
				wake: false,
				note: "recovery normal\nresting HR 52",
			}),
		);
		const schedule = await store.create({
			channel: "fake:health",
			target: "open",
			title: "recovery",
			prompt: "p",
			recurrence: {
				kind: "every",
				time: "09:30",
				everyDays: 1,
				startDate: "2026-09-01",
			},
			nextRun: new Date(Date.now() - 1_000),
			createdById: "u1",
			createdByName: "Sam",
			createdTier: "owner",
			precheck: "health.recovery",
		});
		const posted: { channel: string; chunks: string[] }[] = [];
		const ran: Schedule[] = [];
		const surface: ChatSurface = {
			surface: "fake",
			start: async () => undefined,
			sendReply: async (channel, reply) => {
				posted.push({ channel, chunks: reply.chunks });
			},
		};
		const plugin = await testPlugin(schedulerPlugin(), {
			surfaces: [surface],
			services: [
				// The store keeps private fields, which a test service's proxy cannot reach: give its methods.
				servicePair(SCHEDULES, {
					due: (at: Date) => store.due(at),
					claim: (...args: Parameters<typeof store.claim>) =>
						store.claim(...args),
					recordStatus: (id: number, status: string) =>
						store.recordStatus(id, status),
				}),
				servicePair(PRECHECKS, prechecks),
				servicePair(BACKGROUND_TURNS, {
					runScheduled: async (s: Schedule) => {
						ran.push(s);
						return { status: "ran" as const };
					},
				} satisfies Partial<BackgroundTurns>),
			],
		});
		try {
			for (let i = 0; i < 100 && posted.length === 0; i += 1)
				await Bun.sleep(20);
		} finally {
			await plugin.stop();
		}
		expect(ran).toEqual([]);
		expect((await store.get(schedule.id))?.lastStatus).toBe(
			"skipped by precheck (recovery normal\nresting HR 52)",
		);
		expect(posted).toEqual([
			{
				channel: "fake:health",
				chunks: [
					messages().schedulePrecheckNote(
						schedule.id,
						"recovery",
						"recovery normal\nresting HR 52",
					),
				],
			},
		]);
		expect(posted[0]?.chunks[0]).toBe(
			`-# Schedule #${schedule.id} recovery, skipped by its precheck: recovery normal\n-# resting HR 52`,
		);
	});
});
