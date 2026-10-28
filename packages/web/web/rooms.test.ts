import { describe, expect, test } from "bun:test";
import type {
	PromptFrame,
	RoomMessage,
	RoomView,
	ServerFrame,
} from "../src/api-types.ts";
import {
	type Action,
	banner,
	initialState,
	lastMessage,
	type RoomsState,
	reduce,
	timeline,
	waitingCards,
} from "./lib/rooms.ts";

const GUIDE = "app:agent.guide";
const SCOUT = "app:agent.scout";

const READY: ServerFrame = {
	type: "ready",
	protocol: 1,
	principal: "ada",
	name: "Ada",
	uploads: { perMessage: 4, maxBytes: 10 * 1024 * 1024, types: ["image/png"] },
};

const message = (
	id: number,
	room: string,
	over: Partial<RoomMessage> = {},
): RoomMessage => ({
	id,
	room,
	kind: "agent",
	agent: room.slice(room.indexOf(".") + 1),
	author: "Guide",
	text: `message ${id}`,
	files: [],
	at: "2026-10-28T10:00:00.000Z",
	...over,
});

const view = (key: string, over: Partial<RoomView> = {}): RoomView => ({
	key,
	kind: "agent",
	name: key.slice(key.indexOf(".") + 1),
	displayName: key.slice(key.indexOf(".") + 1),
	home: key === GUIDE,
	readOnly: false,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
	...over,
});

const approval = (id: string, over: Partial<PromptFrame> = {}): PromptFrame =>
	({
		id,
		kind: "approval",
		title: "Send it?",
		message: "Send the note",
		purpose: "action",
		...over,
	}) as PromptFrame;

const run = (actions: Action[], from: RoomsState = initialState()) =>
	actions.reduce(reduce, from);

describe("cards", () => {
	test("a prompt opens a card in its room and prompt_closed ends it", () => {
		let state = run([
			READY,
			{ type: "prompt", room: SCOUT, prompt: approval("p1") },
		]);
		expect(waitingCards(state, SCOUT)).toBe(1);
		expect(waitingCards(state, GUIDE)).toBe(0);
		expect(timeline(state, SCOUT).map((item) => item.kind)).toEqual(["card"]);
		state = reduce(state, {
			type: "prompt_closed",
			prompt: "p1",
			outcome: "approved",
		});
		expect(waitingCards(state, SCOUT)).toBe(0);
		// The ended card stays in the room as a record of how it ended.
		const [item] = timeline(state, SCOUT);
		expect(item).toMatchObject({
			kind: "card",
			card: { outcome: "approved" },
		});
	});

	test("a prompt shown again (a late card) replaces the open one instead of doubling it", () => {
		const state = run([
			READY,
			{ type: "prompt", room: SCOUT, prompt: approval("p1") },
			{ type: "prompt", room: SCOUT, prompt: approval("p1", { late: true }) },
		]);
		expect(waitingCards(state, SCOUT)).toBe(1);
		const [item] = timeline(state, SCOUT);
		expect(item).toMatchObject({ card: { frame: { late: true } } });
	});

	test("a card stands after the message that was last when it opened", () => {
		const state = run([
			READY,
			{ type: "message", room: SCOUT, message: message(1, SCOUT) },
			{ type: "prompt", room: SCOUT, prompt: approval("p1") },
			{ type: "message", room: SCOUT, message: message(2, SCOUT) },
		]);
		expect(
			timeline(state, SCOUT).map((item) =>
				item.kind === "message" ? item.message.id : item.kind,
			),
		).toEqual([1, "card", 2]);
	});

	test("a new ready drops the cards that were open, since the server sends the open ones again", () => {
		let state = run([
			READY,
			{ type: "prompt", room: SCOUT, prompt: approval("p1") },
			{ type: "prompt", room: SCOUT, prompt: approval("p2") },
			{ type: "prompt_closed", prompt: "p2", outcome: "declined" },
		]);
		state = run([READY], state);
		expect(waitingCards(state, SCOUT)).toBe(0);
		state = reduce(state, {
			type: "prompt",
			room: SCOUT,
			prompt: approval("p1"),
		});
		expect(waitingCards(state, SCOUT)).toBe(1);
		// The one that had ended stays a record.
		expect(
			timeline(state, SCOUT).filter(
				(item) => item.kind === "card" && item.card.outcome === "declined",
			),
		).toHaveLength(1);
	});
});

describe("progress", () => {
	const text = (room: string, delta: string): ServerFrame => ({
		type: "progress",
		room,
		event: { type: "text", delta },
	});

	test("streamed text is kept for the focused room only", () => {
		const state = run([
			READY,
			{ type: "focused", room: SCOUT },
			text(SCOUT, "Looking "),
			text(SCOUT, "at it"),
			text(GUIDE, "elsewhere"),
		]);
		expect(state.rooms[SCOUT]?.progress.text).toBe("Looking at it");
		expect(state.rooms[GUIDE]?.progress.text ?? "").toBe("");
	});

	test("tool chips follow start and end", () => {
		const state = run([
			READY,
			{ type: "focused", room: SCOUT },
			{
				type: "progress",
				room: SCOUT,
				event: { type: "tool_start", id: "t1", tool: "read", preview: "a.ts" },
			},
			{
				type: "progress",
				room: SCOUT,
				event: { type: "tool_start", id: "t2", tool: "bash" },
			},
			{
				type: "progress",
				room: SCOUT,
				event: { type: "tool_end", id: "t1", tool: "read", ok: true },
			},
			{
				type: "progress",
				room: SCOUT,
				event: {
					type: "tool_end",
					id: "t2",
					tool: "bash",
					ok: false,
					refused: "declined",
				},
			},
		]);
		expect(state.rooms[SCOUT]?.progress.tools).toEqual([
			{ id: "t1", tool: "read", preview: "a.ts", status: "ok" },
			{ id: "t2", tool: "bash", status: "refused", refused: "declined" },
		]);
	});

	test("progress ends when the agent stops working or its reply arrives", () => {
		const working = run([
			READY,
			{ type: "focused", room: SCOUT },
			{ type: "activity", room: SCOUT, typing: true, stoppable: true },
			text(SCOUT, "thinking"),
		]);
		expect(working.rooms[SCOUT]).toMatchObject({
			typing: true,
			stoppable: true,
		});
		const idle = reduce(working, {
			type: "activity",
			room: SCOUT,
			typing: false,
			stoppable: false,
		});
		expect(idle.rooms[SCOUT]?.progress).toEqual({ text: "", tools: [] });
		const replied = reduce(working, {
			type: "message",
			room: SCOUT,
			message: message(3, SCOUT),
		});
		expect(replied.rooms[SCOUT]?.progress.text).toBe("");
	});
});

describe("modes", () => {
	test("a mode frame sets the banner for its room only", () => {
		let state = run([
			READY,
			{ type: "rooms_loaded", rooms: [view(GUIDE), view(SCOUT)] },
		]);
		expect(banner(state, GUIDE)).toBeUndefined();
		state = reduce(state, {
			type: "mode",
			room: GUIDE,
			yolo: true,
			longRunning: false,
		});
		expect(banner(state, GUIDE)).toEqual({ yolo: true, longRunning: false });
		expect(banner(state, SCOUT)).toBeUndefined();
		state = reduce(state, {
			type: "mode",
			room: GUIDE,
			yolo: false,
			longRunning: true,
		});
		expect(banner(state, GUIDE)).toEqual({ yolo: false, longRunning: true });
		state = reduce(state, {
			type: "mode",
			room: GUIDE,
			yolo: false,
			longRunning: false,
		});
		expect(banner(state, GUIDE)).toBeUndefined();
	});

	test("the room list carries each room's mode", () => {
		const state = run([
			{
				type: "rooms_loaded",
				rooms: [view(SCOUT, { mode: { yolo: true, longRunning: true } })],
			},
		]);
		expect(banner(state, SCOUT)).toEqual({ yolo: true, longRunning: true });
	});

	test("yolo approvals are counted for the room", () => {
		const state = run([
			READY,
			{ type: "auto_approved", room: GUIDE, tool: "bash", action: "git push" },
			{ type: "auto_approved", room: GUIDE, tool: "bash", action: "ls" },
		]);
		expect(state.rooms[GUIDE]?.autoApproved).toBe(2);
	});
});

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
