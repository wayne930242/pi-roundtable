import { expect, test } from "bun:test";
import { describeDb } from "pi-roundtable/testing";
import { parseWebhook } from "./events.ts";
import { InboxWorker } from "./inbox.ts";
import { persistEvents } from "./intake.ts";
import type { LineEvent, LineSubscriber } from "./messages.ts";
import { PgSources } from "./sources.ts";
import {
	bare,
	consumer,
	editEvent,
	enc,
	events,
	logs,
	process,
	refsOf,
	rows,
	run,
	sql,
	subscriber,
	TIME,
	types,
	unsendEvent,
	useConsumerHarness,
} from "./testing/consumer-fixture.ts";
import { body, GROUP, messageEvent } from "./testing/line-fake.ts";
import { truncateAll } from "./testing/pool.ts";

describeDb("the consumer: unsend", () => {
	useConsumerHarness();

	test("a post kept after the unsend is handed back as unsent at once", async () => {
		const kept: { unsent: boolean }[] = [];
		subscriber.answer = async (event, context) => {
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
		subscriber.answer = async (event, context) => {
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
		events.length = 0;
		subscriber.answer = async (_event, context) => {
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
		subscriber.answer = async (event, context) => {
			await run(unsendEvent(event.messageId, "su", 2000));
			subscriber.failNext = new Error("discord down: signal aborted");
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
		events.length = 0;

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
		subscriber.failNext = new Error("cannot delete");
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
		subscriber.answer = async (event) => {
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
		subscriber.answer = async (event) => {
			await run(unsendEvent(event.messageId, "ud", 2000));
			subscriber.failNext = new Error("discord down");
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
			events.length = 0;
			const made: string[] = [];
			subscriber.answer = async (event) => {
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
		subscriber.failNext = Object.assign(
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
