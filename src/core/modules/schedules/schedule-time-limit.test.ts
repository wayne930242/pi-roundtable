import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import type {
	BackgroundTarget,
	BackgroundTurn,
} from "../../contract/channels.ts";
import { ScheduleError } from "../../domain/errors.ts";
import { silentLogger } from "../../log.ts";
import {
	describeDb,
	openTestStore,
	type TestStore,
	testDatabaseUrl,
} from "../../testing/database.ts";
import { useTestLocale } from "../../testing/locale.ts";
import { setTimeZone } from "../../time.ts";
import { ConversationBackgroundTurns } from "../background/background-turns.ts";
import { PgScheduleStore, type Schedule } from "./schedule-store.ts";
import {
	callScheduleTool,
	type ScheduleToolContext,
} from "./schedule-tools.ts";

const TARGET: BackgroundTarget = {
	name: "open",
	label: () => "Open",
	schedules: { perChannel: 5, promptChars: 2_000, aheadDays: 90 },
};
const now = new Date("2026-09-26T15:30:00+08:00");

beforeAll(() => setTimeZone("Asia/Taipei"));
afterAll(useTestLocale);

describeDb("a schedule's own time limit", () => {
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

	const ctx = (): ScheduleToolContext => ({
		store,
		channel: "discord:a",
		target: TARGET,
		author: { principalId: "u1", id: "u1", name: "Sam", tier: "owner" },
		now,
	});
	const create = (extra: Record<string, unknown> = {}) =>
		callScheduleTool(ctx(), "schedule_create", {
			title: "digest",
			prompt: "write the digest",
			time: "23:00",
			...extra,
		});

	test("schedule_create stores it, and the reply and the list say it", async () => {
		const reply = await create({ time_limit_minutes: 90 });
		expect(reply).toContain("each run may work up to 90 min");
		const [schedule] = await store.forChannel("discord:a");
		expect(schedule?.timeLimitMinutes).toBe(90);
		expect(await callScheduleTool(ctx(), "schedule_list", {})).toContain(
			"each run may work up to 90 min",
		);
	});

	test("a schedule without one has none, and says nothing of it", async () => {
		const reply = await create();
		expect(reply).not.toContain("may work up to");
		const [schedule] = await store.forChannel("discord:a");
		expect(schedule).not.toHaveProperty("timeLimitMinutes");
	});

	test("a limit that is no whole number of minutes within the maximum is refused", async () => {
		for (const bad of [0, -5, 1.5, 241, "30", true])
			await expect(create({ time_limit_minutes: bad })).rejects.toThrow(
				ScheduleError,
			);
		await expect(create({ time_limit_minutes: 241 })).rejects.toThrow(
			"from 1 to 240",
		);
		expect(await store.forChannel("discord:a")).toEqual([]);
		// The maximum itself is allowed.
		await create({ time_limit_minutes: 240 });
		expect((await store.forChannel("discord:a"))[0]?.timeLimitMinutes).toBe(
			240,
		);
	});

	test("schedule_update changes it, keeps it when left out, and null removes it", async () => {
		await create({ time_limit_minutes: 30 });
		const id = (await store.forChannel("discord:a"))[0]?.id ?? 0;
		const limit = async () => (await store.get(id))?.timeLimitMinutes;
		await callScheduleTool(ctx(), "schedule_update", { id, title: "renamed" });
		expect(await limit()).toBe(30);
		await callScheduleTool(ctx(), "schedule_update", {
			id,
			time_limit_minutes: 120,
		});
		expect(await limit()).toBe(120);
		await callScheduleTool(ctx(), "schedule_update", {
			id,
			time_limit_minutes: null,
		});
		expect(await limit()).toBeUndefined();
		await expect(
			callScheduleTool(ctx(), "schedule_update", {
				id,
				time_limit_minutes: 999,
			}),
		).rejects.toThrow(ScheduleError);
	});

	test("its turn carries the limit in ms; a schedule without one carries none", async () => {
		const turns: BackgroundTurn[] = [];
		const background = new ConversationBackgroundTurns({
			conversations: {
				background: async (turn) => {
					turns.push(turn);
					return { status: "ran" };
				},
				runsAs: async () => ({ skipped: "unused" }),
			},
			system: { id: "system", name: "system" },
			logger: silentLogger(),
		});
		await create({ time_limit_minutes: 45 });
		await create({ title: "plain" });
		const all: Schedule[] = await store.forChannel("discord:a");
		for (const schedule of all) await background.runScheduled(schedule, now);
		const limited = turns.find((turn) => turn.text.includes("digest"));
		const plain = turns.find((turn) => turn.text.includes("plain"));
		expect(limited?.timeLimitMs).toBe(45 * 60_000);
		expect(plain).not.toHaveProperty("timeLimitMs");
	});
});
