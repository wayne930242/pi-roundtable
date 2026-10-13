import { afterAll, beforeEach, expect, test } from "bun:test";
import type { SQL } from "bun";
import { describeDb, recordingLogger } from "pi-roundtable/testing";
import {
	checkRetention,
	RETENTION_DEFAULTS,
	RetentionSweeper,
} from "./retention.ts";
import { GROUP } from "./testing/line-fake.ts";
import { freshPool, truncateAll } from "./testing/pool.ts";

const NOW = new Date("2026-10-13T12:00:00Z");
const DAY = 24 * 60 * 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

test("the defaults keep everything for seven days and sweep hourly, and a mistake in the options is named", () => {
	expect(RETENTION_DEFAULTS).toEqual({
		inboxMs: 7 * DAY,
		messagesMs: 7 * DAY,
		outboxMs: 7 * DAY,
		strayMs: 15 * 60_000,
		intervalMs: 3_600_000,
	});
	expect(() =>
		checkRetention({ inboxMs: 1000, messagesMs: 5000 }),
	).not.toThrow();
	expect(() => checkRetention({ inboxMs: 0 })).toThrow("retention.inboxMs");
	expect(() => checkRetention({ messagesMs: 1.5 })).toThrow(
		"retention.messagesMs",
	);
	expect(() => checkRetention({ intervalMs: 2_147_483_648 })).toThrow(
		"retention.intervalMs",
	);
	expect(() => checkRetention({ nope: 1 } as never)).toThrow("retention.nope");
});

describeDb("the retention sweeper", () => {
	let sql: SQL;
	const logs = recordingLogger();
	const sweeper = (options = {}) =>
		new RetentionSweeper({ sql, logger: logs.logger, now: () => NOW, options });

	const inbox = async (
		id: string,
		status: string,
		age: number,
		payload: unknown = null,
	) => {
		await sql`INSERT INTO line_inbox
			(webhook_event_id, source_key, event_type, message_id, event_ts, payload, status, next_attempt_at, created_at, completed_at)
			VALUES (${id}, ${GROUP}, 'message', ${`m-${id}`}, 1, ${JSON.stringify(payload)}::text::jsonb, ${status},
				${ago(age)}, ${ago(age)}, ${status === "pending" || status === "processing" ? null : ago(age)})`;
	};
	const ids = async (table: string, column: string) =>
		(
			(await sql.unsafe(`SELECT ${column} AS id FROM ${table} ORDER BY 1`)) as {
				id: string;
			}[]
		).map((r) => r.id);

	beforeEach(async () => {
		sql ??= await freshPool();
		await truncateAll(sql);
		logs.lines.length = 0;
	});
	afterAll(async () => {
		await sql?.close();
	});

	test("finished events and events nobody handled go after their window; fresh and in-flight ones stay", async () => {
		await inbox("done-old", "done", 8 * DAY);
		await inbox("skipped-old", "skipped", 8 * DAY);
		await inbox("dead-old", "dead", 8 * DAY);
		await inbox("done-new", "done", 6 * DAY);
		await inbox("pending-old", "pending", 8 * DAY, {
			message: { text: "never handled" },
		});
		await inbox("pending-new", "pending", DAY, {
			message: { text: "waiting" },
		});
		await inbox("processing-old", "processing", 8 * DAY);
		const counts = await sweeper().sweepOnce();
		expect(counts).toMatchObject({ inbox: 3, inbox_waiting: 1 });
		expect(await ids("line_inbox", "webhook_event_id")).toEqual([
			"done-new",
			"pending-new",
			"processing-old",
		]);
	});

	test("messages, refs and tombstones go after their window, with the tokens they held", async () => {
		for (const [id, age] of [
			["old", 8 * DAY],
			["new", DAY],
		] as const) {
			await sql`INSERT INTO line_messages (source_key, message_id, message_type, event_ts, reply_token, reply_token_at, quote_token, created_at)
				VALUES (${GROUP}, ${id}, 'text', 1, 'reply-token', ${ago(age)}, 'quote-token', ${ago(age)})`;
			await sql`INSERT INTO line_message_refs (source_key, message_id, ref, position, created_at)
				VALUES (${GROUP}, ${id}, ${`ref-${id}`}, 0, ${ago(age)})`;
			await sql`INSERT INTO line_tombstones (source_key, message_id, created_at) VALUES (${GROUP}, ${id}, ${ago(age)})`;
		}
		const counts = await sweeper().sweepOnce();
		expect(counts).toMatchObject({ messages: 1, refs: 1, tombstones: 1 });
		expect(await ids("line_messages", "message_id")).toEqual(["new"]);
		expect(await ids("line_message_refs", "ref")).toEqual(["ref-new"]);
		expect(await ids("line_tombstones", "message_id")).toEqual(["new"]);
	});

	test("pushes go after their window, finished or never sent, with the join notice records; fresh ones stay", async () => {
		const push = async (
			status: string,
			age: number,
			messages: unknown = null,
		) => {
			await sql`INSERT INTO line_outbox
				(source_key, messages, message_count, retry_key, status, created_at, ready_at, next_attempt_at, completed_at)
				VALUES (${GROUP}, ${JSON.stringify(messages)}::text::jsonb, 1, ${crypto.randomUUID()}::uuid, ${status},
					${ago(age)}, ${ago(age)}, ${ago(age)}, ${["queued", "sending"].includes(status) ? null : ago(age)})`;
		};
		await push("sent", 8 * DAY);
		await push("dead", 8 * DAY);
		await push("refused", 8 * DAY);
		await push("queued", 8 * DAY, [{ type: "text", text: "never sent" }]);
		await push("sent", DAY);
		await push("queued", DAY, [{ type: "text", text: "waiting" }]);
		await sql`INSERT INTO line_notices (webhook_event_id, outcome, created_at)
			VALUES ('old-join', 'sent', ${ago(8 * DAY)}), ('new-join', 'failed', ${ago(DAY)})`;
		const counts = await sweeper().sweepOnce();
		expect(counts).toMatchObject({ outbox: 4, notices: 1 });
		expect(await ids("line_outbox", "status")).toEqual(["queued", "sent"]);
		expect(await ids("line_notices", "webhook_event_id")).toEqual(["new-join"]);
		await sweeper({ outboxMs: 3_600_000 }).sweepOnce();
		expect(await ids("line_outbox", "status")).toEqual([]);
		expect(await ids("line_notices", "webhook_event_id")).toEqual([]);
	});

	test("the windows are configurable and independent", async () => {
		await inbox("done-3h", "done", 3 * 3_600_000);
		await sql`INSERT INTO line_tombstones (source_key, message_id, created_at) VALUES (${GROUP}, 't', ${ago(3 * 3_600_000)})`;
		await sweeper({ inboxMs: 2 * 3_600_000 }).sweepOnce();
		expect(await ids("line_inbox", "webhook_event_id")).toEqual([]);
		expect(await ids("line_tombstones", "message_id")).toEqual(["t"]);
		await sweeper({ messagesMs: 2 * 3_600_000 }).sweepOnce();
		expect(await ids("line_tombstones", "message_id")).toEqual([]);
	});

	test("it logs counts only, and nothing when nothing went", async () => {
		await inbox("done-old", "done", 8 * DAY, {
			message: { text: "customer words" },
		});
		await sql`INSERT INTO line_messages (source_key, message_id, message_type, event_ts, reply_token, created_at)
			VALUES (${GROUP}, 'm-secret', 'text', 1, 'REPLY-TOKEN-VALUE', ${ago(8 * DAY)})`;
		await sweeper().sweepOnce();
		const [line] = logs.lines;
		expect(logs.lines).toHaveLength(1);
		expect(line?.fields).toMatchObject({ inbox: 1, messages: 1 });
		const everything = JSON.stringify(logs.lines);
		for (const text of [
			"customer words",
			"REPLY-TOKEN-VALUE",
			"m-secret",
			GROUP,
		])
			expect(everything).not.toContain(text);
		logs.lines.length = 0;
		await sweeper().sweepOnce();
		expect(logs.lines).toEqual([]);
	});

	test("a service that starts sweeps at once and stops cleanly, and says it is busy while a sweep runs", async () => {
		await inbox("done-old", "done", 8 * DAY);
		const s = sweeper({ intervalMs: 3_600_000 });
		expect(s.busy()).toEqual([]);
		s.start();
		for (
			let i = 0;
			i < 200 && (await ids("line_inbox", "webhook_event_id")).length > 0;
			i++
		)
			await Bun.sleep(10);
		expect(await ids("line_inbox", "webhook_event_id")).toEqual([]);
		const running = s.sweepOnce();
		expect(s.busy()).toEqual(["retention"]);
		await running;
		await s.stop();
		expect(s.busy()).toEqual([]);
	});

	test("the sweep hands strays back first, with the cutoff of the stray window; a failure is logged by its code and trimming goes on", async () => {
		await inbox("done-old", "done", 8 * DAY);
		const cutoffs: Date[] = [];
		const counts = await new RetentionSweeper({
			sql,
			logger: logs.logger,
			now: () => NOW,
			options: { strayMs: 60_000 },
			strays: async (before) => {
				cutoffs.push(before);
				// It runs before the tables are trimmed.
				expect(await ids("line_inbox", "webhook_event_id")).toEqual([
					"done-old",
				]);
				return 3;
			},
		}).sweepOnce();
		expect(cutoffs).toEqual([ago(60_000)]);
		expect(counts).toMatchObject({ strays: 3, inbox: 1 });

		await inbox("done-older", "done", 9 * DAY);
		logs.lines.length = 0;
		const failing = await new RetentionSweeper({
			sql,
			logger: logs.logger,
			now: () => NOW,
			strays: async () => {
				throw Object.assign(new Error("subscriber said: secret text"), {
					code: "discord_down",
				});
			},
		}).sweepOnce();
		expect(failing).toMatchObject({ strays: 0, inbox: 1 });
		expect(logs.lines.find((l) => l.level === "warn")?.fields).toMatchObject({
			table: "strays",
			code: "discord_down",
		});
		expect(JSON.stringify(logs.lines)).not.toContain("secret text");
	});

	test("a table that cannot be trimmed is logged by its code and the others still go", async () => {
		await inbox("done-old", "done", 8 * DAY);
		await sql`ALTER TABLE line_tombstones RENAME TO line_tombstones_away`;
		try {
			const counts = await sweeper().sweepOnce();
			expect(counts).toMatchObject({ inbox: 1, tombstones: 0 });
			const warning = logs.lines.find((l) => l.level === "warn");
			expect(warning?.fields).toMatchObject({ table: "tombstones" });
			expect(typeof warning?.fields.code).toBe("string");
		} finally {
			await sql`ALTER TABLE line_tombstones_away RENAME TO line_tombstones`;
		}
	});
});
