import { describe, expect, test } from "bun:test";
import type { ServerFrame } from "../src/api-types.ts";
import { lastMessage, ROOM_PAGE, reduce, timeline } from "./lib/rooms.ts";
import {
	approval,
	GUIDE,
	message,
	READY,
	run,
	SCOUT,
	view,
} from "./rooms-fixture.ts";

describe("messages", () => {
	test("a message frame seen twice, such as after a reconnect, is kept once and in order", () => {
		let state = run([
			READY,
			{ type: "message", room: GUIDE, message: message(5, GUIDE) },
			{ type: "message", room: GUIDE, message: message(6, GUIDE) },
		]);
		state = run(
			[
				READY,
				{ type: "message", room: GUIDE, message: message(6, GUIDE) },
				{ type: "message", room: GUIDE, message: message(7, GUIDE) },
				{ type: "message", room: GUIDE, message: message(5, GUIDE) },
			],
			state,
		);
		expect(state.rooms[GUIDE]?.messages.map((m) => m.id)).toEqual([5, 6, 7]);
	});

	test("the latest page after a reconnect fills the gap without doubling", () => {
		const state = run([
			READY,
			{ type: "message", room: GUIDE, message: message(5, GUIDE) },
			READY,
			{
				type: "history_loaded",
				room: GUIDE,
				messages: [4, 5, 6, 7].map((id) => message(id, GUIDE)),
				more: true,
				older: false,
			},
		]);
		expect(state.rooms[GUIDE]?.messages.map((m) => m.id)).toEqual([4, 5, 6, 7]);
		expect(state.rooms[GUIDE]?.more).toBe(true);
	});

	test("a page that starts after everything we have replaces it, since a gap would hide messages", () => {
		const state = run([
			READY,
			{ type: "message", room: GUIDE, message: message(2, GUIDE) },
			{
				type: "history_loaded",
				room: GUIDE,
				messages: [150, 151].map((id) => message(id, GUIDE)),
				more: true,
				older: false,
			},
		]);
		expect(state.rooms[GUIDE]?.messages.map((m) => m.id)).toEqual([150, 151]);
	});

	test("an older page goes before what is shown", () => {
		const state = run([
			READY,
			{
				type: "history_loaded",
				room: GUIDE,
				messages: [5, 6].map((id) => message(id, GUIDE)),
				more: true,
				older: false,
			},
			{
				type: "history_loaded",
				room: GUIDE,
				messages: [3, 4].map((id) => message(id, GUIDE)),
				more: false,
				older: true,
			},
		]);
		expect(state.rooms[GUIDE]?.messages.map((m) => m.id)).toEqual([3, 4, 5, 6]);
		expect(state.rooms[GUIDE]?.more).toBe(false);
	});

	test("a message between agents joins the room's messages but leaves its live text and progress, which are no reply", () => {
		let state = run([
			READY,
			{ type: "focused", room: GUIDE },
			{
				type: "message",
				room: GUIDE,
				message: message(0, GUIDE, { live: "tok", text: "working" }),
			},
			{
				type: "progress",
				room: GUIDE,
				event: { type: "text", delta: "thinking" },
			},
		]);
		state = reduce(state, {
			type: "message",
			room: GUIDE,
			message: message(8, GUIDE, {
				text: "check the disk",
				intercom: {
					kind: "sent",
					peer: { name: "scout", displayName: "Scout" },
				},
			}),
		});
		expect(state.rooms[GUIDE]?.live.map((m) => m.text)).toEqual(["working"]);
		expect(state.rooms[GUIDE]?.progress.text).toBe("thinking");
		expect(state.rooms[GUIDE]?.messages.map((m) => m.id)).toEqual([8]);
	});

	test("an interim message is replaced by its token and dropped when the agent's reply arrives", () => {
		const live = (text: string): ServerFrame => ({
			type: "message",
			room: GUIDE,
			message: message(0, GUIDE, { live: "tok", text }),
		});
		let state = run([READY, live("one"), live("one two")]);
		expect(state.rooms[GUIDE]?.live.map((m) => m.text)).toEqual(["one two"]);
		expect(timeline(state, GUIDE).map((item) => item.kind)).toEqual(["live"]);
		state = reduce(state, {
			type: "message",
			room: GUIDE,
			message: message(9, GUIDE, { text: "final" }),
		});
		expect(state.rooms[GUIDE]?.live).toEqual([]);
		expect(timeline(state, GUIDE).map((item) => item.kind)).toEqual([
			"message",
		]);
	});

	test("a sent message waits as pending until the server accepts it, or fails with the reason", () => {
		let state = run([
			READY,
			{ type: "queued", id: "c1", room: GUIDE, text: "hi", files: [] },
			{ type: "queued", id: "c2", room: GUIDE, text: "again", files: [] },
		]);
		expect(timeline(state, GUIDE).map((item) => item.kind)).toEqual([
			"pending",
			"pending",
		]);
		state = reduce(state, {
			type: "accepted",
			id: "c1",
			room: GUIDE,
			message: message(1, GUIDE, { kind: "owner", text: "hi", author: "Ada" }),
		});
		state = reduce(state, { type: "refused", id: "c2", code: "too_long" });
		const items = timeline(state, GUIDE);
		expect(items.map((item) => item.kind)).toEqual(["message", "pending"]);
		expect(items[1]).toMatchObject({
			kind: "pending",
			pending: { id: "c2", failed: "too_long" },
		});
		state = reduce(state, { type: "pending_dropped", id: "c2" });
		expect(timeline(state, GUIDE)).toHaveLength(1);
	});

	test("a refusal without a send is kept to be shown, and can be dismissed", () => {
		let state = run([READY, { type: "refused", code: "forbidden" }]);
		expect(state.refusal).toBe("forbidden");
		state = reduce(state, { type: "refusal_dismissed" });
		expect(state.refusal).toBeUndefined();
	});
});

describe("the room list", () => {
	test("keeps the server's order and shows the newest message, from the frames or the list", () => {
		let state = run([
			READY,
			{
				type: "rooms_loaded",
				rooms: [
					view(GUIDE, { last: message(10, GUIDE) }),
					view(SCOUT, { last: message(4, SCOUT) }),
				],
			},
		]);
		expect(state.order).toEqual([GUIDE, SCOUT]);
		expect(lastMessage(state, SCOUT)?.id).toBe(4);
		state = reduce(state, {
			type: "message",
			room: SCOUT,
			message: message(8, SCOUT),
		});
		expect(lastMessage(state, SCOUT)?.id).toBe(8);
		// A list fetched later that knows a newer one wins over older frames.
		state = reduce(state, {
			type: "rooms_loaded",
			rooms: [view(SCOUT, { last: message(12, SCOUT) })],
		});
		expect(lastMessage(state, SCOUT)?.id).toBe(12);
		expect(state.order).toEqual([SCOUT]);
	});

	test("changed asks for the list again, and a ready counts as another connection", () => {
		let state = run([READY]);
		const { revision, connects } = state;
		state = reduce(state, { type: "changed" });
		expect(state.revision).toBe(revision + 1);
		state = reduce(state, READY);
		expect(state.connects).toBe(connects + 1);
		expect(state.connection).toBe("open");
		expect(state.principal).toEqual({ id: "ada", name: "Ada" });
	});
});

describe("the order of a reloaded room", () => {
	test("a card that opened before the page loaded the history stands among the messages by its time", () => {
		// After a reload the server sends the open card before the history arrives.
		let state = run([
			READY,
			{
				type: "prompt",
				room: SCOUT,
				prompt: approval("p1", { at: "2026-10-28T10:02:30.000Z" }),
			},
		]);
		state = reduce(state, {
			type: "history_loaded",
			room: SCOUT,
			messages: [
				message(1, SCOUT, { at: "2026-10-28T10:00:00.000Z" }),
				message(2, SCOUT, { at: "2026-10-28T10:02:00.000Z" }),
				message(3, SCOUT, { at: "2026-10-28T10:03:00.000Z" }),
			],
			more: false,
			older: false,
		});
		expect(
			timeline(state, SCOUT).map((item) =>
				item.kind === "message" ? item.message.id : item.kind,
			),
		).toEqual([1, 2, "card", 3]);
	});

	test("a card older than every message shown stands first, and one newer stands last", () => {
		const state = run([
			READY,
			{
				type: "prompt",
				room: SCOUT,
				prompt: approval("old", { at: "2026-10-28T09:00:00.000Z" }),
			},
			{
				type: "prompt",
				room: SCOUT,
				prompt: approval("new", { at: "2026-10-28T11:00:00.000Z" }),
			},
			{
				type: "history_loaded",
				room: SCOUT,
				messages: [message(1, SCOUT), message(2, SCOUT)],
				more: false,
				older: false,
			},
		]);
		expect(
			timeline(state, SCOUT).map((item) =>
				item.kind === "message" ? item.message.id : item.kind,
			),
		).toEqual(["card", 1, 2, "card"]);
	});
});

describe("a refused answer", () => {
	test("is counted on its card, so the card can offer its buttons again", () => {
		let state = run([
			READY,
			{ type: "prompt", room: SCOUT, prompt: approval("p1") },
		]);
		expect(state.cards.p1?.refused).toBeUndefined();
		state = reduce(state, {
			type: "refused",
			prompt: "p1",
			code: "bad_frame",
		});
		expect(state.cards.p1?.refused).toBe(1);
		expect(state.refusal).toBe("bad_frame");
		state = reduce(state, { type: "refused", prompt: "p1", code: "forbidden" });
		expect(state.cards.p1?.refused).toBe(2);
		// A refusal of a card that is gone changes no card.
		const gone = reduce(state, {
			type: "refused",
			prompt: "gone",
			code: "unknown_prompt",
		});
		expect(gone.cards).toEqual(state.cards);
		expect(gone.refusal).toBe("unknown_prompt");
	});
});

describe("how much of a room is kept", () => {
	const many = (room: string, from: number, count: number) =>
		Array.from({ length: count }, (_, i) => message(from + i, room));

	test("a room the page does not show keeps only its latest page as messages arrive", () => {
		let state = run([
			READY,
			{ type: "focused", room: SCOUT },
			{
				type: "history_loaded",
				room: SCOUT,
				messages: many(SCOUT, 1, 120),
				more: false,
				older: false,
			},
			{ type: "focused", room: GUIDE },
		]);
		// Leaving the room trims what it held.
		expect(state.rooms[SCOUT]?.messages).toHaveLength(ROOM_PAGE);
		expect(state.rooms[SCOUT]?.messages[0]?.id).toBe(71);
		expect(state.rooms[SCOUT]?.more).toBe(true);
		for (let id = 121; id <= 200; id++)
			state = reduce(state, {
				type: "message",
				room: SCOUT,
				message: message(id, SCOUT),
			});
		expect(state.rooms[SCOUT]?.messages).toHaveLength(ROOM_PAGE);
		expect(state.rooms[SCOUT]?.messages.at(-1)?.id).toBe(200);
		expect(state.rooms[SCOUT]?.more).toBe(true);
	});

	test("the room the page shows keeps everything loaded, in order, however messages arrive", () => {
		let state = run([
			READY,
			{ type: "focused", room: SCOUT },
			{
				type: "history_loaded",
				room: SCOUT,
				messages: many(SCOUT, 1, 120),
				more: false,
				older: false,
			},
			{ type: "message", room: SCOUT, message: message(122, SCOUT) },
			{ type: "message", room: SCOUT, message: message(121, SCOUT) },
		]);
		expect(state.rooms[SCOUT]?.messages.map((m) => m.id)).toEqual(
			Array.from({ length: 122 }, (_, i) => i + 1),
		);
		state = reduce(state, {
			type: "message",
			room: SCOUT,
			message: message(122, SCOUT),
		});
		expect(state.rooms[SCOUT]?.messages).toHaveLength(122);
	});
});
