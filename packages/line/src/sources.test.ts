import { afterAll, beforeEach, expect, test } from "bun:test";
import type { SQL } from "bun";
import { describeDb } from "pi-roundtable/testing";
import { LineApi } from "./api.ts";
import { LineApiError, LineError } from "./errors.ts";
import { parseWebhook } from "./events.ts";
import { persistEvents } from "./intake.ts";
import { PgSources } from "./sources.ts";
import {
	body,
	CHANNEL_ID,
	fakeLine,
	GROUP,
	messageEvent,
	OTHER_GROUP,
	SECRET,
} from "./testing/line-fake.ts";
import { freshPool } from "./testing/pool.ts";
import { TokenSource } from "./token.ts";

describeDb("the sources", () => {
	let sql: SQL;
	let time = new Date("2026-10-13T00:00:00Z");
	const line = fakeLine();
	const api = new LineApi({
		tokens: new TokenSource({
			credentials: { channelId: CHANNEL_ID, channelSecret: SECRET },
			fetch: line.fetch,
		}),
		fetch: line.fetch,
	});
	const sources = () =>
		new PgSources(
			sql,
			() => api,
			() => time,
		);
	const receive = async (...events: Record<string, unknown>[]) =>
		persistEvents(
			sql,
			(await parseWebhook(new TextEncoder().encode(body(...events)))).events,
			time,
		);

	beforeEach(async () => {
		sql ??= await freshPool();
		await sql`TRUNCATE line_inbox, line_sources`;
		time = new Date("2026-10-13T00:00:00Z");
	});
	afterAll(async () => {
		await sql?.close();
	});

	test("pending lists unseen chats oldest first, with counts and no content", async () => {
		await receive(messageEvent({ id: "a" }), messageEvent({ id: "b" }));
		time = new Date("2026-10-13T01:00:00Z");
		await receive(messageEvent({ id: "c", group: "Cgroup0002" }));
		const pending = await sources().pending();
		expect(pending.map((s) => [s.key, s.eventCount, s.messageCount])).toEqual([
			[GROUP, 2, 2],
			[OTHER_GROUP, 1, 1],
		]);
		expect(pending[0]).toMatchObject({
			kind: "group",
			status: "pending",
			firstSeenAt: "2026-10-13T00:00:00.000Z",
		});
		expect(JSON.stringify(pending)).not.toContain("hello there");
	});

	test("allow and block change the status and are repeatable; list filters by it", async () => {
		await receive(
			messageEvent(),
			messageEvent({ id: "o", group: "Cgroup0002" }),
		);
		const allowed = await sources().allow(GROUP);
		expect(allowed.status).toBe("allowed");
		expect((await sources().allow(GROUP)).status).toBe("allowed");
		expect((await sources().block(OTHER_GROUP)).status).toBe("blocked");
		expect((await sources().list("allowed")).map((s) => s.key)).toEqual([
			GROUP,
		]);
		expect(await sources().pending()).toEqual([]);
		expect((await sources().allow(OTHER_GROUP)).status).toBe("allowed");
	});

	test("an unseen or malformed key is refused with a code, and a chat the bot left cannot be allowed", async () => {
		await expect(sources().allow("line:group:Cunseen")).rejects.toMatchObject({
			code: "unknown_source",
		});
		await expect(sources().block("line:group:Cunseen")).rejects.toMatchObject({
			code: "unknown_source",
		});
		await expect(sources().allow("group:Cgroup0001")).rejects.toMatchObject({
			code: "bad_source_key",
		});
		await receive(messageEvent());
		await sources().markLeft(GROUP, 5);
		await expect(sources().allow(GROUP)).rejects.toMatchObject({
			code: "source_left",
		});
		expect((await sources().get(GROUP))?.status).toBe("left");
		expect(await sources().get("line:group:Cunseen")).toBeUndefined();
	});

	test("block drops what waits in the inbox for that chat, payload and all", async () => {
		await receive(messageEvent({ id: "first" }));
		await sources().allow(GROUP);
		await receive(messageEvent({ id: "queued", text: "unread words" }));
		await sources().block(GROUP);
		const rows =
			await sql`SELECT status, payload, last_error_code FROM line_inbox WHERE webhook_event_id = 'queued'`;
		expect(rows[0]).toMatchObject({
			status: "skipped",
			payload: null,
			last_error_code: "source_blocked",
		});
	});

	test("a membership change older than the last one applied is ignored", async () => {
		await receive(messageEvent());
		await sources().markLeft(GROUP, 100);
		await sources().markJoined(GROUP, 50);
		expect((await sources().get(GROUP))?.status).toBe("left");
		await sources().markJoined(GROUP, 200);
		expect((await sources().get(GROUP))?.status).toBe("pending");
		await sources().allow(GROUP);
		await sources().markLeft(GROUP, 150);
		expect((await sources().get(GROUP))?.status).toBe("allowed");
		await sources().block(GROUP);
		await sources().markLeft(GROUP, 300);
		expect((await sources().get(GROUP))?.status).toBe("blocked");
	});

	test("summary adds the group's name from LINE, and fails loudly when LINE does", async () => {
		await receive(
			messageEvent(),
			messageEvent({ id: "u", group: "Cgroup0002" }),
		);
		expect((await sources().summary(GROUP)).name).toBe("Group One");
		await expect(sources().summary(OTHER_GROUP)).rejects.toBeInstanceOf(
			LineApiError,
		);
		await receive({
			...messageEvent({ id: "p" }),
			source: { type: "user", userId: "Uperson0001" },
		});
		expect((await sources().summary("line:user:Uperson0001")).name).toBeNull();
		await expect(
			sources().summary("line:group:Cunseen"),
		).rejects.toBeInstanceOf(LineError);
	});
});
