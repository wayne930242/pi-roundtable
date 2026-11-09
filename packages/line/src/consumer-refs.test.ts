import { expect, test } from "bun:test";
import { describeDb } from "pi-roundtable/testing";
import {
	bare,
	consumer,
	events,
	inbox,
	plainEvent,
	refsOf,
	rows,
	run,
	sql,
	subscriber,
	types,
	unsendEvent,
	useConsumerHarness,
} from "./testing/consumer-fixture.ts";
import { GROUP, messageEvent } from "./testing/line-fake.ts";

describeDb("the consumer: refs", () => {
	useConsumerHarness();

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
		subscriber.answer = async () => ({ refs: ["a", "b", "a"] });
		await run(messageEvent({ id: "dup", messageId: "mdup" }));
		expect((await rows("line_message_refs")).map((r) => r.ref)).toEqual([
			"a",
			"b",
		]);
		subscriber.answer = async () => undefined;
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
			subscriber.answer = async () => ({ refs });
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
		subscriber.failNext = new Error("discord down");
		await expect(
			run(messageEvent({ id: "f", messageId: "mf" })),
		).rejects.toThrow("discord down");
		expect(await rows("line_messages")).toEqual([]);
		await run(messageEvent({ id: "f", messageId: "mf" }));
		expect((await rows("line_messages")).length).toBe(1);
	});

	test("a subscriber that throws after keeping a post leaves it stored for the retry, and an unsend takes back every post", async () => {
		let attempt = 0;
		subscriber.answer = async (_event, context) => {
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

		subscriber.answer = async (_event, context) => {
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
			subscriber.answer = async () => wrong;
			await expect(
				run(messageEvent({ id: "w", messageId: "mw" })),
			).rejects.toMatchObject({ code: "bad_refs" });
		}
		expect(await rows("line_messages")).toEqual([]);
		subscriber.answer = async () => undefined;
		await run(messageEvent({ id: "w", messageId: "mw" }));
		expect(await rows("line_messages")).toHaveLength(1);
	});
});
