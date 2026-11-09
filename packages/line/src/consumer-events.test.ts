import { expect, test } from "bun:test";
import { describeDb } from "pi-roundtable/testing";
import type { LineMessageEvent } from "./messages.ts";
import {
	editEvent,
	events,
	logs,
	plainEvent,
	rows,
	run,
	types,
	unsendEvent,
	useConsumerHarness,
} from "./testing/consumer-fixture.ts";
import { GROUP, mediaEvent, messageEvent } from "./testing/line-fake.ts";

describeDb("the consumer: events", () => {
	useConsumerHarness();

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
});
