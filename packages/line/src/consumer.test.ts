import { afterAll, beforeEach, expect, test } from "bun:test";
import type { SQL } from "bun";
import { describeDb, recordingLogger } from "pi-roundtable/testing";
import { LineConsumer } from "./consumer.ts";
import { parseWebhook } from "./events.ts";
import { type InboxEvent, type InboxProcessor, InboxWorker } from "./inbox.ts";
import { persistEvents } from "./intake.ts";
import type {
	LineContext,
	LineEvent,
	LineMessageEvent,
	LineSubscriber,
	LineUnsentEvent,
} from "./messages.ts";
import { PgSources } from "./sources.ts";
import { body, GROUP, mediaEvent, messageEvent } from "./testing/line-fake.ts";
import { freshPool, truncateAll } from "./testing/pool.ts";

const TIME = new Date("2026-10-13T00:00:00Z");
const enc = (value: string) => new TextEncoder().encode(value);
const refsOf = (event: LineEvent | undefined): readonly string[] =>
	(event as LineUnsentEvent).refs;

const unsendEvent = (
	messageId: string,
	id: string,
	timestamp: number,
): Record<string, unknown> => ({
	type: "unsend",
	mode: "active",
	timestamp,
	webhookEventId: id,
	source: { type: "group", groupId: "Cgroup0001", userId: "Uuser0001" },
	unsend: { messageId },
});

const editEvent = (
	messageId: string,
	id: string,
	timestamp: number,
	text: string,
): Record<string, unknown> => ({
	...messageEvent({ id, timestamp, messageId, type: "messageEdited", text }),
	message: { id: messageId, type: "text", text, quoteToken: `quote-${id}` },
});

const plainEvent = (
	type: string,
	extra: Record<string, unknown> = {},
	id = `${type}-1`,
): Record<string, unknown> => ({
	type,
	mode: "active",
	timestamp: 1_700_000_005_000,
	webhookEventId: id,
	source: { type: "group", groupId: "Cgroup0001" },
	replyToken: `reply-${id}`,
	...extra,
});

describeDb("the consumer", () => {
	let sql: SQL;
	const logs = recordingLogger();
	let events: LineEvent[] = [];
	/** What the stub subscriber answers for a message; default two refs named after the message. */
	let answer: (
		event: LineMessageEvent,
		context: LineContext,
	) => Promise<unknown> = async (event) => ({
		refs: [`post-${event.messageId}-1`, `post-${event.messageId}-2`],
	});
	let failNext: Error | undefined;
	let consumer: LineConsumer;
	let process: InboxProcessor;

	const inbox = async (
		raw: Record<string, unknown>,
		attempt = 1,
	): Promise<InboxEvent> => {
		const [parsed] = (await parseWebhook(enc(body(raw)))).events;
		if (!parsed) throw new Error("no event");
		return {
			id: parsed.id,
			type: parsed.type,
			sourceKey: parsed.sourceKey,
			messageId: parsed.messageId,
			timestamp: parsed.timestamp,
			payload: parsed.raw,
			attempt,
		};
	};
	const run = async (raw: Record<string, unknown>) =>
		process(await inbox(raw), new AbortController().signal);
	const types = () => events.map((e) => e.type);
	const rows = async (table: string) =>
		sql.unsafe(`SELECT * FROM ${table} ORDER BY 1, 2, 3`) as Promise<
			Record<string, unknown>[]
		>;
	/** The rows without their creation time, which these tests fix anyway. */
	const bare = async (table: string) =>
		(await rows(table)).map(({ created_at: _, ...rest }) => rest);

	beforeEach(async () => {
		sql ??= await freshPool();
		await truncateAll(sql);
		events = [];
		failNext = undefined;
		logs.lines.length = 0;
		answer = async (event) => ({
			refs: [`post-${event.messageId}-1`, `post-${event.messageId}-2`],
		});
		consumer = new LineConsumer({ sql, logger: logs.logger, now: () => TIME });
		process = consumer.processorFor(async (event, _signal, context) => {
			events.push(event);
			if (failNext) {
				const error = failNext;
				failNext = undefined;
				throw error;
			}
			if (event.type === "message")
				return answer(event, context) as ReturnType<LineSubscriber>;
			return undefined;
		});
	});
	afterAll(async () => {
		await sql?.close();
	});

	test("every kind of message becomes a typed event with what a mirror needs", async () => {
		const cases: [Record<string, unknown>, unknown][] = [
			[
				{ type: "text", text: "hello" },
				{ kind: "text", text: "hello" },
			],
			[{ type: "image", contentProvider: { type: "line" } }, { kind: "image" }],
			[
				{ type: "video", duration: 4000 },
				{ kind: "video", durationMs: 4000 },
			],
			[
				{ type: "audio", duration: 1500 },
				{ kind: "audio", durationMs: 1500 },
			],
			[
				{ type: "file", fileName: "plan.pdf", fileSize: 2048 },
				{ kind: "file", fileName: "plan.pdf", fileSize: 2048 },
			],
			[
				{
					type: "sticker",
					packageId: "446",
					stickerId: "1988",
					keywords: ["hi", "wave"],
				},
				{
					kind: "sticker",
					packageId: "446",
					stickerId: "1988",
					keywords: ["hi", "wave"],
				},
			],
			[
				{
					type: "location",
					title: "Office",
					address: "1 Example Road",
					latitude: 25.03,
					longitude: 121.56,
				},
				{
					kind: "location",
					title: "Office",
					address: "1 Example Road",
					latitude: 25.03,
					longitude: 121.56,
				},
			],
			[{ type: "hologram" }, { kind: "unsupported", messageType: "hologram" }],
		];
		for (const [index, [message]] of cases.entries())
			await run(
				mediaEvent(message, { id: `k${index}`, messageId: `mk${index}` }),
			);
		expect(events.map((e) => (e as LineMessageEvent).body)).toEqual(
			cases.map(([, expected]) => expected) as never,
		);
		expect(events[0]).toEqual({
			type: "message",
			eventId: "k0",
			sourceKey: GROUP,
			timestamp: 1_700_000_000_000,
			messageId: "mk0",
			userId: "Uuser0001",
			body: { kind: "text", text: "hello" },
		});
		// A quoted message is named.
		await run(
			mediaEvent(
				{ type: "text", text: "re", quotedMessageId: "mk0" },
				{ id: "q", messageId: "mq" },
			),
		);
		expect((events.at(-1) as LineMessageEvent).quotedMessageId).toBe("mk0");
	});

	test("a message that lacks what its type needs fails with a code, and nothing is stored", async () => {
		await expect(
			run(mediaEvent({ type: "location", title: "x" }, { id: "bad" })),
		).rejects.toMatchObject({ code: "bad_message" });
		await expect(
			run({ ...messageEvent({ id: "nomsg" }), message: undefined }),
		).rejects.toBeDefined();
		expect(events).toEqual([]);
		expect(await rows("line_messages")).toEqual([]);
	});

	test("joins, leaves and member changes are typed, and events a mirror does not show are ignored", async () => {
		await run(plainEvent("join"));
		await run(plainEvent("leave"));
		await run(
			plainEvent("memberJoined", {
				joined: {
					members: [
						{ type: "user", userId: "Uan" },
						{ type: "user", userId: "Ubo" },
					],
				},
			}),
		);
		await run(
			plainEvent("memberLeft", {
				left: { members: [{ type: "user", userId: "Uan" }] },
			}),
		);
		await run(plainEvent("memberJoined", { joined: { members: [] } }, "empty"));
		await run(plainEvent("follow"));
		await run(plainEvent("postback", { postback: { data: "x" } }));
		expect(events).toEqual([
			{
				type: "joined",
				eventId: "join-1",
				sourceKey: GROUP,
				timestamp: 1_700_000_005_000,
				notice: "unconfirmed",
			},
			{
				type: "left",
				eventId: "leave-1",
				sourceKey: GROUP,
				timestamp: 1_700_000_005_000,
			},
			{
				type: "memberJoined",
				eventId: "memberJoined-1",
				sourceKey: GROUP,
				timestamp: 1_700_000_005_000,
				userIds: ["Uan", "Ubo"],
			},
			{
				type: "memberLeft",
				eventId: "memberLeft-1",
				sourceKey: GROUP,
				timestamp: 1_700_000_005_000,
				userIds: ["Uan"],
			},
		]);
	});

	test("an event that names no chat is skipped with a log line and no subscriber call", async () => {
		const raw = {
			...messageEvent({ id: "nosrc" }),
			source: { type: "unknown" },
		};
		expect(await run(raw)).toBeUndefined();
		expect(events).toEqual([]);
		expect(logs.lines.some((l) => l.level === "warn")).toBe(true);
	});

	test("refs are stored one to many in order with the tokens, and a redelivery neither calls the subscriber nor stores twice", async () => {
		const raw = {
			...messageEvent({ id: "r1", messageId: "mr1" }),
			message: {
				id: "mr1",
				type: "text",
				text: "hi",
				quoteToken: "quote-token-r1",
			},
		};
		await run(raw);
		expect(types()).toEqual(["message"]);
		expect(await bare("line_message_refs")).toEqual([
			{ source_key: GROUP, message_id: "mr1", ref: "post-mr1-1", position: 0 },
			{ source_key: GROUP, message_id: "mr1", ref: "post-mr1-2", position: 1 },
		]);
		const [message] = await rows("line_messages");
		expect(message).toMatchObject({
			source_key: GROUP,
			message_id: "mr1",
			message_type: "text",
			reply_token: "reply-r1",
			quote_token: "quote-token-r1",
		});
		expect((message?.reply_token_at as Date | undefined)?.getTime()).toBe(
			1_700_000_000_000,
		);
		await run(raw);
		await run(raw);
		expect(types()).toEqual(["message"]);
		expect((await rows("line_message_refs")).length).toBe(2);
		expect((await rows("line_messages")).length).toBe(1);
	});

	test("refs the subscriber repeats are stored once, and it may answer with none", async () => {
		answer = async () => ({ refs: ["a", "b", "a"] });
		await run(messageEvent({ id: "dup", messageId: "mdup" }));
		expect((await rows("line_message_refs")).map((r) => r.ref)).toEqual([
			"a",
			"b",
		]);
		answer = async () => undefined;
		await run(messageEvent({ id: "none", messageId: "mnone" }));
		expect(
			(await rows("line_messages")).map((r) => r.message_id).sort(),
		).toEqual(["mdup", "mnone"]);
		// With no refs there is still a record that it was mirrored, so a redelivery does not mirror it again.
		await run(messageEvent({ id: "none", messageId: "mnone" }));
		expect(events.filter((e) => e.type === "message").length).toBe(2);
	});

	test("refs a subscriber may not return are refused and nothing is stored", async () => {
		for (const refs of [
			[""],
			["a\u0000b"],
			["x".repeat(513)],
			Array.from({ length: 101 }, (_, i) => `r${i}`),
			[7],
		]) {
			answer = async () => ({ refs });
			await expect(
				run(messageEvent({ id: "badref", messageId: "mbad" })),
			).rejects.toMatchObject({
				code: "bad_refs",
			});
		}
		expect(await rows("line_messages")).toEqual([]);
		expect(await rows("line_message_refs")).toEqual([]);
	});

	test("a subscriber that throws leaves nothing stored, so the event is mirrored again on retry", async () => {
		failNext = new Error("discord down");
		await expect(
			run(messageEvent({ id: "f", messageId: "mf" })),
		).rejects.toThrow("discord down");
		expect(await rows("line_messages")).toEqual([]);
		await run(messageEvent({ id: "f", messageId: "mf" }));
		expect((await rows("line_messages")).length).toBe(1);
	});

	test("a subscriber that throws after keeping a post leaves it stored for the retry, and an unsend takes back every post", async () => {
		let attempt = 0;
		answer = async (_event, context) => {
			const n = attempt++;
			await context.keep(`chunk1-try${n}`);
			if (n === 0) throw new Error("discord 502 on chunk 2");
			await context.keep("chunk2");
			// What is returned at the end merges with what was kept.
			return { refs: [`chunk1-try${n}`, "chunk2"] };
		};
		await expect(
			run(messageEvent({ id: "k", messageId: "mk" })),
		).rejects.toThrow("discord 502");
		expect(await rows("line_messages")).toEqual([]);
		expect((await rows("line_message_refs")).map((r) => r.ref)).toEqual([
			"chunk1-try0",
		]);
		await run(messageEvent({ id: "k", messageId: "mk" }));
		expect(await rows("line_messages")).toHaveLength(1);
		const stored = await sql`SELECT ref, position FROM line_message_refs
			WHERE message_id = 'mk' ORDER BY position`;
		expect(stored).toEqual([
			{ ref: "chunk1-try0", position: 0 },
			{ ref: "chunk1-try1", position: 1 },
			{ ref: "chunk2", position: 2 },
		]);
		await run(unsendEvent("mk", "ku", 2000));
		expect(refsOf(events.at(-1))).toEqual([
			"chunk1-try0",
			"chunk1-try1",
			"chunk2",
		]);
		expect(await rows("line_message_refs")).toEqual([]);
	});

	test("a post kept after the unsend is handed back as unsent at once", async () => {
		const kept: { unsent: boolean }[] = [];
		answer = async (event, context) => {
			kept.push(await context.keep("a"));
			await run(unsendEvent(event.messageId, "ju", 2000));
			kept.push(await context.keep("b"));
			return { refs: ["a", "b"] };
		};
		await run(messageEvent({ id: "j", messageId: "mj" }));
		expect(kept).toEqual([{ unsent: false }, { unsent: true }]);
		// The unsend took "a" back; keeping "b" found the tombstone and took "b" back straight away.
		expect(types()).toEqual(["message", "unsent", "unsent"]);
		expect(events.slice(1).map((e) => refsOf(e))).toEqual([["a"], ["b"]]);
		expect(await rows("line_messages")).toEqual([]);
		expect(await rows("line_message_refs")).toEqual([]);
		expect(await rows("line_tombstones")).toHaveLength(1);
	});

	test("a ref kept and also returned at the end is handed back once, whatever order the unsend came in (R5R-F001)", async () => {
		answer = async (event, context) => {
			await context.keep("r1");
			await run(unsendEvent(event.messageId, "fu", 2000));
			await context.keep("r2");
			// Both are offered again at the end; neither is handed back a second time.
			return { refs: ["r1", "r2"] };
		};
		await run(messageEvent({ id: "f1", messageId: "mf1" }));
		expect(
			events.filter((e) => e.type === "unsent").map((e) => refsOf(e)),
		).toEqual([["r1"], ["r2"]]);
		expect(await rows("line_message_refs")).toEqual([]);

		// No unsend at all: a kept ref that is returned again is stored once.
		events = [];
		answer = async (_event, context) => {
			await context.keep("s1");
			return { refs: ["s1", "s2"] };
		};
		await run(messageEvent({ id: "f2", messageId: "mf2" }));
		expect(types()).toEqual(["message"]);
		expect(
			(await rows("line_message_refs")).map((r) => [r.ref, r.position]),
		).toEqual([
			["s1", 0],
			["s2", 1],
		]);
	});

	test("a ref stored for a tombstoned message that nobody handed back is handed back by the stray pass until it is gone (R5R-F002)", async () => {
		const aborted = new AbortController();
		// A handler that outlived its lease: its signal is aborted, so the subscriber refuses the take-back.
		answer = async (event, context) => {
			await run(unsendEvent(event.messageId, "su", 2000));
			failNext = new Error("discord down: signal aborted");
			await context.keep("late-post").catch(() => undefined);
			throw new Error("the stale handler gives up");
		};
		await expect(
			run(messageEvent({ id: "s0", messageId: "ms" })),
		).rejects.toThrow("gives up");
		// The message and the unsend are both finished; only the ref is left, with its tombstone.
		expect((await rows("line_message_refs")).map((r) => r.ref)).toEqual([
			"late-post",
		]);
		expect(await rows("line_tombstones")).toHaveLength(1);
		events = [];

		const handler: LineSubscriber = async (event) => {
			events.push(event);
			return undefined;
		};
		// Too young: an unsend or a keep in flight may still be taking it back.
		const young = new Date(TIME.getTime() - 60_000);
		expect(await consumer.handBackStrays(handler, aborted.signal, young)).toBe(
			0,
		);
		expect(events).toEqual([]);

		// A take-back that fails keeps the ref for the next pass and does not stop the others.
		const failing: LineSubscriber = async () => {
			throw new Error("discord still down");
		};
		expect(
			await consumer.handBackStrays(
				failing,
				aborted.signal,
				new Date(TIME.getTime() + 1),
			),
		).toBe(0);
		expect(await rows("line_message_refs")).toHaveLength(1);

		const later = new Date(TIME.getTime() + 1);
		expect(await consumer.handBackStrays(handler, aborted.signal, later)).toBe(
			1,
		);
		expect(events).toMatchObject([
			{ type: "unsent", messageId: "ms", refs: ["late-post"] },
		]);
		expect(await rows("line_message_refs")).toEqual([]);
		// Nothing is left for the next pass.
		expect(await consumer.handBackStrays(handler, aborted.signal, later)).toBe(
			0,
		);
		expect(events).toHaveLength(1);
		// A message that is not tombstoned is never a stray, however old its refs.
		await sql`INSERT INTO line_message_refs (source_key, message_id, ref, position, created_at)
			VALUES (${GROUP}, 'live', 'live-ref', 0, ${new Date(0)})`;
		expect(await consumer.handBackStrays(handler, aborted.signal, later)).toBe(
			0,
		);
	});

	test("a ref that is old is not a stray while the unsend that took its message back is young (R6-F002)", async () => {
		const aborted = new AbortController();
		await sql`INSERT INTO line_message_refs (source_key, message_id, ref, position, created_at)
			VALUES (${GROUP}, 'slow', 'slow-post', 0, ${new Date(0)})`;
		await sql`INSERT INTO line_tombstones (source_key, message_id, created_at)
			VALUES (${GROUP}, 'slow', ${TIME})`;
		const seen: LineEvent[] = [];
		const handler: LineSubscriber = async (event) => {
			seen.push(event);
			return undefined;
		};
		const before = new Date(TIME.getTime() - 60_000);
		expect(await consumer.handBackStrays(handler, aborted.signal, before)).toBe(
			0,
		);
		expect(seen).toEqual([]);
		const after = new Date(TIME.getTime() + 1);
		expect(await consumer.handBackStrays(handler, aborted.signal, after)).toBe(
			1,
		);
	});

	test("keeping is refused outside a message, and past the limit of refs for one message", async () => {
		let outsider: unknown;
		const probing = consumer.processorFor(async (event, _signal, context) => {
			if (event.type === "left")
				outsider = await context.keep("x").catch((e) => e);
		});
		await probing(
			await inbox(plainEvent("leave")),
			new AbortController().signal,
		);
		expect(outsider).toMatchObject({ code: "keep_unavailable" });

		answer = async (_event, context) => {
			for (let i = 0; i < 100; i++) await context.keep(`r${i}`);
			return { refs: ["one-too-many"] };
		};
		await expect(
			run(messageEvent({ id: "lim", messageId: "mlim" })),
		).rejects.toMatchObject({ code: "bad_refs" });
		expect(await rows("line_message_refs")).toHaveLength(100);
		expect(await rows("line_messages")).toEqual([]);
	});

	test("an answer that is not { refs } fails instead of counting as mirrored with no refs", async () => {
		for (const wrong of [{ retryInMs: 1000 }, {}, null, "ok", 7]) {
			answer = async () => wrong;
			await expect(
				run(messageEvent({ id: "w", messageId: "mw" })),
			).rejects.toMatchObject({ code: "bad_refs" });
		}
		expect(await rows("line_messages")).toEqual([]);
		answer = async () => undefined;
		await run(messageEvent({ id: "w", messageId: "mw" }));
		expect(await rows("line_messages")).toHaveLength(1);
	});

	test("an edit carries the refs of the original, and the latest edit wins however they arrive", async () => {
		await run(messageEvent({ id: "e0", messageId: "me", text: "first" }));
		await run(editEvent("me", "e2", 1_700_000_020_000, "third"));
		await run(editEvent("me", "e1", 1_700_000_010_000, "second"));
		// The same edit again (a redelivery) is not shown twice.
		await run(editEvent("me", "e2", 1_700_000_020_000, "third"));
		const edits = events.filter((e) => e.type === "edited");
		expect(edits).toEqual([
			{
				type: "edited",
				eventId: "e2",
				sourceKey: GROUP,
				timestamp: 1_700_000_020_000,
				messageId: "me",
				text: "third",
				refs: ["post-me-1", "post-me-2"],
			},
		]);
	});

	test("an edit of a message that is not mirrored, was unsent or is not text is skipped", async () => {
		await run(editEvent("never", "x1", 1_700_000_010_000, "who"));
		await run(messageEvent({ id: "u0", messageId: "mu" }));
		await run({
			...editEvent("mu", "x2", 1_700_000_010_000, "x"),
			message: { id: "mu", type: "image" },
		});
		await run(unsendEvent("mu", "u1", 1_700_000_030_000));
		await run(editEvent("mu", "x3", 1_700_000_040_000, "after"));
		expect(types()).toEqual(["message", "unsent"]);
	});

	test("an unsend after the message writes a tombstone, drops every stored payload and metadata, and hands the refs over", async () => {
		const sources = new PgSources(
			sql,
			() => ({}) as never,
			() => TIME,
		);
		await persistEvents(
			sql,
			(await parseWebhook(enc(body(messageEvent({ id: "seed" }))))).events,
			TIME,
		);
		await sources.allow(GROUP);
		await persistEvents(
			sql,
			(
				await parseWebhook(
					enc(
						body(
							messageEvent({ id: "p0", messageId: "mp", timestamp: 1000 }),
							editEvent("mp", "p1", 2000, "edited text"),
							unsendEvent("mp", "p2", 3000),
							messageEvent({
								id: "other",
								messageId: "mother",
								timestamp: 1500,
							}),
						),
					),
				)
			).events,
			TIME,
		);
		await run(messageEvent({ id: "p0", messageId: "mp" }));
		await run(unsendEvent("mp", "p2", 3000));
		expect(events.at(-1)).toEqual({
			type: "unsent",
			eventId: "p2",
			sourceKey: GROUP,
			timestamp: 3000,
			messageId: "mp",
			refs: ["post-mp-1", "post-mp-2"],
		});
		expect(await bare("line_tombstones")).toEqual([
			{ source_key: GROUP, message_id: "mp" },
		]);
		expect(await rows("line_messages")).toEqual([]);
		expect(await rows("line_message_refs")).toEqual([]);
		const stored =
			(await sql`SELECT webhook_event_id, payload FROM line_inbox WHERE message_id = 'mp'`) as {
				webhook_event_id: string;
				payload: unknown;
			}[];
		expect(stored.map((r) => r.webhook_event_id).sort()).toEqual([
			"p0",
			"p1",
			"p2",
		]);
		expect(stored.every((r) => r.payload === null)).toBe(true);
		// Another message's payload stays.
		const [other] =
			await sql`SELECT payload FROM line_inbox WHERE message_id = 'mother'`;
		expect(other.payload.message.text).toBe("hello there");
	});

	test("an unsend the subscriber failed to take back is handed the same refs again", async () => {
		await run(messageEvent({ id: "k0", messageId: "mk" }));
		failNext = new Error("cannot delete");
		await expect(run(unsendEvent("mk", "k1", 2000))).rejects.toThrow(
			"cannot delete",
		);
		expect(await rows("line_tombstones")).toHaveLength(1);
		expect((await rows("line_message_refs")).length).toBe(2);
		await run(unsendEvent("mk", "k1", 2000));
		expect(events.filter((e) => e.type === "unsent").map(refsOf)).toEqual([
			["post-mk-1", "post-mk-2"],
			["post-mk-1", "post-mk-2"],
		]);
		expect(await rows("line_message_refs")).toEqual([]);
		// A third delivery has nothing left to take back, and the subscriber is told so.
		await run(unsendEvent("mk", "k1", 2000));
		expect(refsOf(events.at(-1))).toEqual([]);
	});

	test("an unsend before the message is heard with no refs, and the message is never mirrored", async () => {
		await run(unsendEvent("mearly", "ue", 1000));
		expect(events).toEqual([
			{
				type: "unsent",
				eventId: "ue",
				sourceKey: GROUP,
				timestamp: 1000,
				messageId: "mearly",
				refs: [],
			},
		]);
		await run(messageEvent({ id: "late", messageId: "mearly" }));
		expect(types()).toEqual(["unsent"]);
		expect(await rows("line_messages")).toEqual([]);
		expect(await rows("line_message_refs")).toEqual([]);
	});

	test("an unsend that lands while the message is being mirrored takes the new mirror back at once", async () => {
		answer = async (event) => {
			// The sender takes it back while the subscriber is still posting.
			await run(unsendEvent(event.messageId, "ud", 2000));
			return { refs: ["late-1", "late-2"] };
		};
		await run(messageEvent({ id: "d0", messageId: "md" }));
		expect(types()).toEqual(["message", "unsent", "unsent"]);
		// The unsend saw nothing yet; the message's own handling then took the refs it had just made back.
		expect(refsOf(events[1])).toEqual([]);
		expect(events[2]).toMatchObject({
			messageId: "md",
			refs: ["late-1", "late-2"],
		});
		expect(await rows("line_messages")).toEqual([]);
		expect(await rows("line_message_refs")).toEqual([]);
		expect(await rows("line_tombstones")).toHaveLength(1);
	});

	test("a late tombstone whose take-back fails keeps the refs, and the retry takes them back", async () => {
		answer = async (event) => {
			await run(unsendEvent(event.messageId, "ud", 2000));
			failNext = new Error("discord down");
			return { refs: ["late-1"] };
		};
		await expect(
			run(messageEvent({ id: "d0", messageId: "md" })),
		).rejects.toThrow("discord down");
		expect((await rows("line_message_refs")).map((r) => r.ref)).toEqual([
			"late-1",
		]);
		// The retry finds the tombstone first and hands the refs back instead of mirroring.
		await run(messageEvent({ id: "d0", messageId: "md" }));
		expect(events.at(-1)).toMatchObject({
			type: "unsent",
			messageId: "md",
			refs: ["late-1"],
		});
		expect(events.filter((e) => e.type === "message")).toHaveLength(1);
		expect(await rows("line_message_refs")).toEqual([]);
	});

	test("however a message and its unsend interleave, every ref made is taken back and nothing is left", async () => {
		for (let trial = 0; trial < 25; trial++) {
			await truncateAll(sql);
			events = [];
			const made: string[] = [];
			answer = async (event) => {
				await Bun.sleep(Math.floor(Math.random() * 6));
				const refs = [`${event.messageId}-a`, `${event.messageId}-b`];
				made.push(...refs);
				return { refs };
			};
			const unsend = (async () => {
				await Bun.sleep(Math.floor(Math.random() * 8));
				await run(unsendEvent("mrace", "ur", 2000));
			})();
			await Promise.all([
				run(messageEvent({ id: "m0", messageId: "mrace" })),
				unsend,
			]);
			// Whichever order they ran in, a redelivery of the unsend finds nothing more to take back.
			await run(unsendEvent("mrace", "ur", 2000));
			const taken = events.flatMap((e) => (e.type === "unsent" ? e.refs : []));
			for (const ref of made) expect(taken).toContain(ref);
			expect(await rows("line_message_refs")).toEqual([]);
			expect(await rows("line_messages")).toEqual([]);
		}
	});

	test("the reply token, the quote token and message text appear in no log line, and a subscriber failure logs a code only", async () => {
		const raw = {
			...messageEvent({
				id: "t0",
				messageId: "mt",
				text: "a secret customer sentence",
			}),
			message: {
				id: "mt",
				type: "text",
				text: "a secret customer sentence",
				quoteToken: "QUOTE-TOKEN-VALUE",
			},
			replyToken: "REPLY-TOKEN-VALUE",
		};
		await run(raw);
		failNext = Object.assign(
			new Error("failed with REPLY-TOKEN-VALUE and a secret customer sentence"),
			{
				code: "discord_down",
			},
		);
		await expect(run(unsendEvent("mt", "t1", 2000))).rejects.toThrow();
		await run(unsendEvent("mt", "t1", 2000));
		await run(raw);
		await run(editEvent("mt", "t2", 3000, "a secret customer sentence"));
		const everything = JSON.stringify(logs.lines);
		for (const secret of [
			"REPLY-TOKEN-VALUE",
			"QUOTE-TOKEN-VALUE",
			"secret customer",
			"post-mt",
		])
			expect(everything).not.toContain(secret);
		// The subscriber never sees a token either.
		expect(JSON.stringify(events)).not.toContain("TOKEN-VALUE");
	});

	test("through the worker, a message and its unsend arrive in order and the unsent payloads are gone", async () => {
		const sources = new PgSources(
			sql,
			() => ({}) as never,
			() => TIME,
		);
		const seed = await parseWebhook(enc(body(messageEvent({ id: "seed" }))));
		await persistEvents(sql, seed.events, TIME);
		await sources.allow(GROUP);
		await persistEvents(
			sql,
			(
				await parseWebhook(
					enc(
						body(
							messageEvent({ id: "w0", messageId: "mw", timestamp: 1000 }),
							unsendEvent("mw", "w1", 2000),
							messageEvent({ id: "w2", messageId: "mw2", timestamp: 3000 }),
						),
					),
				)
			).events,
			TIME,
		);
		const worker = new InboxWorker({
			sql,
			logger: logs.logger,
			now: () => TIME,
			sources,
			processor: () => process,
			random: () => 1,
			options: { pollMs: 20, dependencyRetryMs: 10 },
		});
		while (await worker.runOnce());
		expect(
			events.map((e) => `${e.type}:${"messageId" in e ? e.messageId : ""}`),
		).toEqual(["message:mw", "unsent:mw", "message:mw2"]);
		expect(refsOf(events[1])).toEqual(["post-mw-1", "post-mw-2"]);
		const stored =
			await sql`SELECT webhook_event_id, status, payload FROM line_inbox
			WHERE webhook_event_id IN ('w0', 'w1', 'w2') ORDER BY webhook_event_id`;
		expect(stored.map((r: { status: string }) => r.status)).toEqual([
			"done",
			"done",
			"done",
		]);
		expect(stored.every((r: { payload: unknown }) => r.payload === null)).toBe(
			true,
		);
	});
});
