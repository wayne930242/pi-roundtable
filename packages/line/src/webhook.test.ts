import { afterAll, beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { describeDb, recordingLogger } from "pi-roundtable/testing";
import { PgSources } from "./sources.ts";
import {
	BOT,
	body,
	CHANNEL_ID,
	fakeLine,
	GROUP,
	messageEvent,
	OTHER_GROUP,
	SECRET,
	sign,
	webhookRequest,
} from "./testing/line-fake.ts";
import { freshPool } from "./testing/pool.ts";
import { TokenSource } from "./token.ts";
import { webhookHandler } from "./webhook.ts";

describeDb("the webhook", () => {
	let sql: SQL;
	let stored = 0;
	let bot: string | undefined = BOT;
	const logs = recordingLogger();
	const tokens = new TokenSource({
		credentials: { channelId: CHANNEL_ID, channelSecret: SECRET },
		fetch: fakeLine().fetch,
	});
	const time = new Date("2026-10-13T00:00:00Z");
	const handler = (options: { sql?: SQL; maxBytes?: number } = {}) =>
		webhookHandler({
			sql: options.sql ?? sql,
			tokens,
			logger: logs.logger,
			now: () => time,
			botUserId: () => bot,
			stored: () => {
				stored++;
			},
			...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
		});
	const sources = () =>
		new PgSources(
			sql,
			() => fakeLine() as never,
			() => time,
		);

	beforeEach(async () => {
		sql ??= await freshPool();
		await sql`TRUNCATE line_inbox, line_sources`;
		stored = 0;
		bot = BOT;
		logs.lines.length = 0;
	});
	afterAll(async () => {
		await sql?.close();
	});

	const rows = () =>
		sql`SELECT webhook_event_id, source_key, event_type, message_id, payload, status, last_error_code
			FROM line_inbox ORDER BY seq`;

	test("an unknown source is recorded as pending with counts only, and its content is never stored", async () => {
		const response = await handler()(
			webhookRequest(body(messageEvent({ text: "secret customer words" }))),
		);
		expect(response.status).toBe(200);
		const [row] = await rows();
		expect(row).toMatchObject({
			status: "skipped",
			payload: null,
			last_error_code: "source_not_allowed",
		});
		const dump = JSON.stringify(await sql`SELECT * FROM line_inbox`);
		expect(dump).not.toContain("secret customer words");
		expect(dump).not.toContain("reply-ev-1");
		const [pending] = await sources().pending();
		expect(pending).toMatchObject({
			key: GROUP,
			status: "pending",
			eventCount: 1,
			messageCount: 1,
		});
		expect(stored).toBe(0);
	});

	test("an allowed source's event is stored whole and wakes the worker before 200", async () => {
		await handler()(webhookRequest(body(messageEvent({ id: "first" }))));
		await sources().allow(GROUP);
		const response = await handler()(
			webhookRequest(body(messageEvent({ id: "ev-2", text: "kept words" }))),
		);
		expect(response.status).toBe(200);
		expect(stored).toBe(1);
		const found = await rows();
		expect(found.map((r: { status: string }) => r.status)).toEqual([
			"skipped",
			"pending",
		]);
		expect(found[1].payload.message.text).toBe("kept words");
	});

	test("a blocked source drops its events, but a join is kept for a source that is merely unknown", async () => {
		const join = {
			...messageEvent({ id: "join-1" }),
			type: "join",
			message: undefined,
		};
		await handler()(webhookRequest(body(join)));
		expect((await rows())[0]).toMatchObject({ status: "pending" });
		await sources().block(GROUP);
		await handler()(
			webhookRequest(body({ ...join, webhookEventId: "join-2" })),
		);
		expect((await rows())[1]).toMatchObject({
			status: "skipped",
			last_error_code: "source_blocked",
			payload: null,
		});
	});

	test("an event of a bot in standby mode, or with no chat, is dropped", async () => {
		await handler()(
			webhookRequest(
				body(
					{ ...messageEvent({ id: "standby" }), mode: "standby" },
					{ type: "things", webhookEventId: "no-chat", timestamp: 1 },
				),
			),
		);
		const found = await rows();
		expect(
			found.map((r: { last_error_code: string }) => r.last_error_code),
		).toEqual(["standby", "no_source"]);
		expect(found.every((r: { payload: unknown }) => r.payload === null)).toBe(
			true,
		);
	});

	test("the signature covers the raw bytes: tampering, a missing header and re-serialization are 401", async () => {
		const raw = `{"destination":"${BOT}",   "events":[]}`;
		expect((await handler()(webhookRequest(raw))).status).toBe(200);
		const tampered = raw.replace("events", "evants");
		expect(
			(await handler()(webhookRequest(tampered, { signature: sign(raw) })))
				.status,
		).toBe(401);
		expect(
			(await handler()(webhookRequest(raw, { signature: null }))).status,
		).toBe(401);
		const compact = JSON.stringify(JSON.parse(raw));
		expect(
			(await handler()(webhookRequest(compact, { signature: sign(raw) })))
				.status,
		).toBe(401);
		expect(
			(
				await handler()(
					webhookRequest(raw, { signature: sign(raw, "another-secret") }),
				)
			).status,
		).toBe(401);
		expect((await rows()).length).toBe(0);
	});

	test("a body over the cap is 413, whether it declares its size or not", async () => {
		const big = "x".repeat(2048);
		const declared = webhookRequest(big, {
			headers: { "content-length": String(big.length) },
		});
		expect((await handler({ maxBytes: 1024 })(declared)).status).toBe(413);
		const stream = new Request("https://hook.example.test/line/webhook", {
			method: "POST",
			headers: { "x-line-signature": sign(big) },
			body: new ReadableStream({
				pull(controller) {
					controller.enqueue(new TextEncoder().encode(big));
				},
			}),
			duplex: "half",
		});
		expect((await handler({ maxBytes: 1024 })(stream)).status).toBe(413);
		expect((await handler()(webhookRequest(big))).status).toBe(400);
	});

	test("a body that is not an events object is 400, and a request that is not a POST is 405", async () => {
		for (const bad of ["not json", "[]", '{"destination":"x"}'])
			expect((await handler()(webhookRequest(bad))).status).toBe(400);
		const get = new Request("https://hook.example.test/line/webhook");
		expect((await handler()(get)).status).toBe(405);
	});

	test("an empty events array (Verify) is 200 and stores nothing, with or without a known bot", async () => {
		const verify = JSON.stringify({ destination: BOT, events: [] });
		expect((await handler()(webhookRequest(verify))).status).toBe(200);
		bot = undefined;
		expect((await handler()(webhookRequest(verify))).status).toBe(200);
		expect((await rows()).length).toBe(0);
	});

	test("a destination other than the bot is 403 once the bot is known, and vouched by signature before", async () => {
		const other = JSON.stringify({
			destination: "Uanother",
			events: [messageEvent()],
		});
		expect((await handler()(webhookRequest(other))).status).toBe(403);
		expect((await rows()).length).toBe(0);
		bot = undefined;
		expect((await handler()(webhookRequest(other))).status).toBe(200);
		expect((await rows()).length).toBe(1);
	});

	test("a redelivered event is stored once, also when deliveries race", async () => {
		await sources()
			.allow(GROUP)
			.catch(() => undefined);
		await handler()(webhookRequest(body(messageEvent({ id: "seed" }))));
		await sources().allow(GROUP);
		const request = () => webhookRequest(body(messageEvent({ id: "same" })));
		const answers = await Promise.all(
			Array.from({ length: 12 }, () => handler()(request())),
		);
		expect(answers.every((r) => r.status === 200)).toBe(true);
		const same = (await rows()).filter(
			(r: { webhook_event_id: string }) => r.webhook_event_id === "same",
		);
		expect(same.length).toBe(1);
		const [source] =
			await sql`SELECT event_count FROM line_sources WHERE source_key = ${GROUP}`;
		expect(Number(source.event_count)).toBe(2);
	});

	test("one request with several sources stores each in one transaction or none", async () => {
		await handler()(
			webhookRequest(
				body(
					messageEvent({ id: "a" }),
					messageEvent({ id: "b", group: "Cgroup0002" }),
				),
			),
		);
		const keys = (await sources().list()).map((s) => s.key);
		expect(keys).toEqual([GROUP, OTHER_GROUP]);
		// An event with no id gets a stable one, so its redelivery is a duplicate too.
		const anonymous = {
			...messageEvent({ id: "x" }),
			webhookEventId: undefined,
		};
		await handler()(webhookRequest(body(anonymous)));
		await handler()(webhookRequest(body(anonymous)));
		expect(
			(await rows()).filter((r: { webhook_event_id: string }) =>
				r.webhook_event_id.startsWith("derived:"),
			).length,
		).toBe(1);
	});

	test("a database that is down answers 500 and logs a code, not the error", async () => {
		const dead = new SQL("postgres://postgres@127.0.0.1:1/none", {
			max: 1,
			connectionTimeout: 1,
		});
		const response = await handler({ sql: dead })(
			webhookRequest(body(messageEvent({ text: "words in flight" }))),
		);
		expect(response.status).toBe(500);
		const line = logs.lines.find((l) => l.level === "error");
		expect(line?.fields.code).toBeString();
		expect(JSON.stringify(logs.lines)).not.toContain("words in flight");
		await dead.close().catch(() => undefined);
	});
});
