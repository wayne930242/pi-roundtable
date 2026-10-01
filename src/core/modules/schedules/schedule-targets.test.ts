import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import type { ChatInputCommandInteraction } from "discord.js";
import type {
	BackgroundTarget,
	BackgroundTurn,
	ChannelClaim,
} from "../../contract/channels.ts";
import { ScheduleCommands } from "../../discord/schedule-commands.ts";
import { ScheduleError } from "../../domain/errors.ts";
import { silentLogger } from "../../log.ts";
import { ChannelQueue } from "../../routing/channel-queue.ts";
import { ChannelRouter } from "../../routing/channel-router.ts";
import {
	describeDb,
	openTestStore,
	type TestStore,
	testDatabaseUrl,
} from "../../testing/database.ts";
import { useTestLocale } from "../../testing/locale.ts";
import { setTimeZone } from "../../time.ts";
import { ConversationBackgroundTurns } from "../background/background-turns.ts";
import { PgScheduleStore } from "./schedule-store.ts";
import {
	callScheduleTool,
	type ScheduleToolContext,
} from "./schedule-tools.ts";
import { Scheduler } from "./scheduler.ts";

const taipei = (stamp: string) =>
	new Date(`${stamp.replace(" ", "T")}:00+08:00`);

beforeAll(() => setTimeZone("Asia/Taipei"));
afterAll(useTestLocale);

/** Two sample targets with limits of their own; neither is a host's own. */
const MAIN: BackgroundTarget = {
	name: "main",
	label: () => "Main desk",
	schedules: { perChannel: 20, promptChars: 8_000, aheadDays: 366 },
	delegation: { maxRunning: 3 },
};
const SUPPORT: BackgroundTarget = {
	name: "support",
	label: () => "Support line",
	schedules: { perChannel: 2, promptChars: 30, aheadDays: 7 },
	delegation: { maxRunning: 1 },
};
const TARGETS = [MAIN, SUPPORT];

/** A claim over the channels with `prefix` that answers only `target` and logs each turn it runs. */
function claim(
	prefix: string,
	target: BackgroundTarget,
	log: string[],
): ChannelClaim {
	return {
		name: target.name,
		priority: 0,
		owns: (channel) => channel.startsWith(`discord:${prefix}`),
		admit: () => undefined,
		background: async (turn: BackgroundTurn) => {
			if (turn.target !== target.name)
				return {
					status: "skipped",
					reason: `${target.name} skips ${turn.target}`,
				};
			log.push(`${target.name} ran ${turn.channel} ${turn.turnId}`);
			return { status: "ran" };
		},
		startFresh: async () => target.name,
	};
}

describeDb("background targets on stored schedules", () => {
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

	/** A row as the schedules table held it before targets: the column is `mode`. */
	async function insertLegacy(channel: string, mode: string, nextRun: Date) {
		const admin = new SQL(testDatabaseUrl);
		await admin`
			INSERT INTO schedules (channel_key, mode, title, prompt, recurrence, next_run,
				created_by_id, created_by_name, created_tier)
			VALUES (${channel}, ${mode}, ${`${mode} row`}, 'p',
				${JSON.stringify({ kind: "every", time: "09:00", everyDays: 1, startDate: "2026-09-26" })},
				${nextRun}, 'u1', 'Sam', 'owner')`;
		await admin.close();
	}

	const ctx = (
		over: Partial<ScheduleToolContext> = {},
	): ScheduleToolContext => ({
		store,
		channel: "discord:support1",
		target: SUPPORT,
		author: { id: "u1", name: "Sam" },
		now: taipei("2026-09-26 23:30"),
		...over,
	});

	function scheduler(clock: { now: Date }, log: string[]) {
		const router = new ChannelRouter({
			claims: [claim("main", MAIN, log), claim("support", SUPPORT, log)],
			targets: (name) => TARGETS.find((t) => t.name === name),
			queue: new ChannelQueue(),
			logger: silentLogger(),
		});
		return new Scheduler({
			store,
			runner: new ConversationBackgroundTurns({
				conversations: router,
				system: { id: "assistant", name: "Assistant" },
				logger: silentLogger(),
			}),
			logger: silentLogger(),
			now: () => clock.now,
		});
	}

	test("rows stored with the old mode values read back as targets, and stay that way when run", async () => {
		await insertLegacy("discord:main1", "owner", taipei("2026-09-27 09:00"));
		await insertLegacy("discord:support1", "open", taipei("2026-09-27 09:00"));
		expect((await store.all()).map((s) => [s.channel, s.target])).toEqual([
			["discord:main1", "owner"],
			["discord:support1", "open"],
		]);
		// The stored name is the target's name: a column value is never rewritten.
		const created = await callScheduleTool(ctx(), "schedule_create", {
			title: "t",
			prompt: "p",
			time: "10:00",
		});
		expect(created).toContain("Scheduled");
		const admin = new SQL(testDatabaseUrl);
		const rows =
			await admin`SELECT channel_key, mode FROM schedules ORDER BY id`;
		await admin.close();
		expect(rows.map((r: { mode: string }) => r.mode)).toEqual([
			"owner",
			"open",
			"support",
		]);
	});

	test("a third target has its own limits, and its schedules fire through its own claim", async () => {
		await callScheduleTool(ctx(), "schedule_create", {
			title: "a",
			prompt: "p",
			time: "10:00",
		});
		await callScheduleTool(ctx(), "schedule_create", {
			title: "b",
			prompt: "p",
			time: "11:00",
		});
		await expect(
			callScheduleTool(ctx(), "schedule_create", {
				title: "c",
				prompt: "p",
				time: "12:00",
			}),
		).rejects.toThrow("cancel one first");
		await expect(
			callScheduleTool(
				ctx({ channel: "discord:support2" }),
				"schedule_create",
				{
					title: "long",
					prompt: "x".repeat(31),
					time: "10:00",
				},
			),
		).rejects.toThrow("within 30");
		await expect(
			callScheduleTool(
				ctx({ channel: "discord:support2" }),
				"schedule_create",
				{
					title: "far",
					prompt: "p",
					at: "2026-10-06 10:00",
				},
			),
		).rejects.toThrow("within 7 days");
		// The main target keeps its own, larger limits in another channel.
		await callScheduleTool(
			ctx({ channel: "discord:main1", target: MAIN }),
			"schedule_create",
			{ title: "m", prompt: "x".repeat(31), time: "12:00" },
		);

		const log: string[] = [];
		const clock = { now: taipei("2026-09-27 10:00") };
		const s = scheduler(clock, log);
		await s.tick();
		await s.idle();
		expect(log.filter((line) => line.startsWith("support ran"))).toHaveLength(
			1,
		);
		expect(log.some((line) => line.startsWith("main ran"))).toBe(false);
		clock.now = taipei("2026-09-27 12:00");
		await s.tick();
		await s.idle();
		expect(log.filter((line) => line.startsWith("support ran"))).toHaveLength(
			2,
		);
		expect(log.filter((line) => line.startsWith("main ran"))).toHaveLength(1);
		expect((await store.all()).map((x) => x.lastStatus)).toEqual([
			"ran",
			"ran",
			"ran",
		]);
	});

	test("a schedule of a target no plugin contributes is skipped with the reason, never run, and kept", async () => {
		await insertLegacy("discord:main1", "retired", taipei("2026-09-27 09:00"));
		const log: string[] = [];
		const clock = { now: taipei("2026-09-27 09:00") };
		const s = scheduler(clock, log);
		await s.tick();
		await s.idle();
		expect(log).toEqual([]);
		const [kept] = await store.all();
		expect(kept?.target).toBe("retired");
		expect(kept?.lastStatus).toBe(
			'skipped: no plugin contributes the background target "retired"',
		);
		expect(kept?.nextRun).toEqual(taipei("2026-09-28 09:00"));
	});

	test("a target without schedule limits may not create schedules", async () => {
		const closed: BackgroundTarget = { name: "closed", label: () => "Closed" };
		await expect(
			callScheduleTool(ctx({ target: closed }), "schedule_create", {
				title: "a",
				prompt: "p",
				time: "10:00",
			}),
		).rejects.toThrow(ScheduleError);
	});

	test("the schedule list names each schedule's target by its label, and by name when nobody contributes it", async () => {
		await insertLegacy(
			"discord:support1",
			"support",
			taipei("2026-09-27 09:00"),
		);
		await insertLegacy("discord:main1", "retired", taipei("2026-09-27 09:00"));
		const edits: unknown[] = [];
		const interaction = {
			options: { getSubcommand: () => "list" },
			editReply: async (payload: unknown) => void edits.push(payload),
			followUp: async () => {},
		} as unknown as ChatInputCommandInteraction;
		await new ScheduleCommands(
			store,
			(name) => TARGETS.find((t) => t.name === name)?.label("en") ?? name,
		).command(interaction);
		const text = JSON.stringify(edits);
		expect(text).toContain("Support line");
		expect(text).toContain("retired");
	});
});
