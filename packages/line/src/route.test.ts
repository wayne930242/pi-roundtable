import { afterAll, beforeEach, expect, test } from "bun:test";
import type { SQL } from "bun";
import type { InboundMessage } from "pi-roundtable";
import { describeDb, recordingLogger } from "pi-roundtable/testing";
import { LineConsumer } from "./consumer.ts";
import { parseWebhook } from "./events.ts";
import type { InboxEvent } from "./inbox.ts";
import type { LineMessageEvent } from "./messages.ts";
import { inboundOf, stripSelfMentions } from "./route.ts";
import { body, mediaEvent, messageEvent } from "./testing/line-fake.ts";
import { freshPool, truncateAll } from "./testing/pool.ts";

const TIME = new Date("2026-10-13T00:00:00Z");

test("the bot's own mentions are cut out of the text and other mentions stay", () => {
	const message = {
		mention: {
			mentionees: [
				{ index: 0, length: 4, userId: "Ubot", isSelf: true },
				{ index: 12, length: 4, userId: "Uother" },
			],
		},
	};
	expect(stripSelfMentions("@bot hello @ann", message)).toEqual({
		text: "hello @ann",
		mentionsBot: true,
	});
	expect(
		stripSelfMentions("hello @ann", {
			mention: { mentionees: [{ index: 6, length: 4, isSelf: false }] },
		}),
	).toEqual({ text: "hello @ann", mentionsBot: false });
	// A span outside the text is ignored instead of trusted.
	expect(
		stripSelfMentions("hi", {
			mention: { mentionees: [{ index: 5, length: 9, isSelf: true }] },
		}),
	).toEqual({ text: "hi", mentionsBot: false });
	expect(stripSelfMentions("hi", {})).toEqual({
		text: "hi",
		mentionsBot: false,
	});
});

test("a text message from a named sender becomes a message of the line surface; nothing else does", () => {
	const event = (over: Partial<LineMessageEvent>): LineMessageEvent => ({
		type: "message",
		eventId: "e1",
		sourceKey: "line:group:Cgroup0001",
		timestamp: 1,
		messageId: "m1",
		userId: "Uuser0001",
		body: { kind: "text", text: "hello" },
		...over,
	});
	expect(inboundOf(event({}), {})).toEqual({
		channel: "line:group:Cgroup0001",
		messageId: "m1",
		actor: {
			provider: "line",
			subject: "Uuser0001",
			name: "Uuser0001",
			surface: "line",
		},
		authorId: "Uuser0001",
		authorName: "Uuser0001",
		authorIsBot: false,
		isDirect: false,
		mentionsBot: false,
		repliesToBot: false,
		text: "hello",
		attachments: [],
	});
	expect(
		inboundOf(event({ sourceKey: "line:user:Uuser0001" }), {})?.isDirect,
	).toBe(true);
	expect(inboundOf(event({ body: { kind: "image" } }), {})).toBeUndefined();
	expect(inboundOf(event({ userId: undefined as never }), {})).toBeUndefined();
});

describeDb("routing through the consumer", () => {
	let sql: SQL;
	const logs = recordingLogger();
	let routed: InboundMessage[] = [];
	let routeError: Error | undefined;
	let consumer: LineConsumer;

	const run = async (raw: Record<string, unknown>) => {
		const [parsed] = (await parseWebhook(new TextEncoder().encode(body(raw))))
			.events;
		if (!parsed) throw new Error("no event");
		const inbox: InboxEvent = {
			id: parsed.id,
			type: parsed.type,
			sourceKey: parsed.sourceKey,
			messageId: parsed.messageId,
			timestamp: parsed.timestamp,
			payload: parsed.raw,
			attempt: 1,
		};
		return consumer.processorFor(async () => ({ refs: ["post-1"] }))(
			inbox,
			new AbortController().signal,
		);
	};

	beforeEach(async () => {
		sql ??= await freshPool();
		await truncateAll(sql);
		routed = [];
		routeError = undefined;
		consumer = new LineConsumer({
			sql,
			logger: logs.logger,
			now: () => TIME,
			route: (message) => {
				if (routeError) throw routeError;
				routed.push(message);
			},
		});
	});
	afterAll(async () => {
		await sql?.close();
	});

	test("text is routed once after it is mirrored; media, and a redelivery of a recorded message, are not", async () => {
		await run(messageEvent({ id: "t1", messageId: "mt1", text: "route me" }));
		await run(mediaEvent({ type: "image" }, { id: "i1", messageId: "mi1" }));
		await run(messageEvent({ id: "t1", messageId: "mt1", text: "route me" }));
		expect(routed.map((m) => [m.channel, m.messageId, m.text])).toEqual([
			["line:group:Cgroup0001", "mt1", "route me"],
		]);
	});

	test("a router that is not ready fails the event for a retry, and the message is not recorded as handled", async () => {
		routeError = new Error("not started");
		await expect(
			run(messageEvent({ id: "t2", messageId: "mt2" })),
		).rejects.toThrow("not started");
		expect(Array.from(await sql`SELECT 1 FROM line_messages`)).toEqual([]);
		routeError = undefined;
		await run(messageEvent({ id: "t2", messageId: "mt2" }));
		expect(routed).toHaveLength(1);
	});

	test("an unsent message is not routed", async () => {
		await sql`INSERT INTO line_tombstones (source_key, message_id, created_at) VALUES ('line:group:Cgroup0001', 'mt3', ${TIME})`;
		await run(messageEvent({ id: "t3", messageId: "mt3" }));
		expect(routed).toEqual([]);
	});
});
