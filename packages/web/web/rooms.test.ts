import { describe, expect, test } from "bun:test";
import type {
	ClosedCard,
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
	ROOM_PAGE,
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
	uploads: { perMessage: 4, maxBytes: 100 * 1024 * 1024 },
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

describe("presence", () => {
	test("activity keeps the phase, the speaker and the outcome per room", () => {
		let state = run([
			READY,
			{ type: "rooms_loaded", rooms: [view(GUIDE), view(SCOUT)] },
			{
				type: "activity",
				room: GUIDE,
				typing: true,
				stoppable: true,
				phase: "working",
				agent: "scout",
			},
		]);
		expect(state.rooms[GUIDE]?.phase).toBe("working");
		expect(state.rooms[GUIDE]?.agent).toBe("scout");
		expect(state.rooms[SCOUT]?.phase).toBeUndefined();
		state = reduce(state, {
			type: "activity",
			room: GUIDE,
			typing: true,
			stoppable: true,
			phase: "thinking",
			agent: "scout",
		});
		expect(state.rooms[GUIDE]?.phase).toBe("thinking");
		state = reduce(state, {
			type: "activity",
			room: GUIDE,
			typing: false,
			stoppable: false,
			outcome: "done",
			at: 1000,
		});
		const room = state.rooms[GUIDE];
		expect(room?.typing).toBe(false);
		expect(room?.phase).toBeUndefined();
		expect(room?.agent).toBeUndefined();
		expect(room?.outcome).toBe("done");
		expect(room?.outcomeAt).toBe(1000);
		expect(room?.activityAt).toBe(1000);
		// The other room has none of it.
		expect(state.rooms[SCOUT]?.outcome).toBeUndefined();
	});

	test("a new turn clears the old outcome, and a failure stays until then", () => {
		let state = run([
			READY,
			{
				type: "activity",
				room: GUIDE,
				typing: false,
				stoppable: false,
				outcome: "failed",
				at: 5,
			},
		]);
		expect(state.rooms[GUIDE]?.outcome).toBe("failed");
		// An activity frame that is not an ending leaves it.
		state = reduce(state, {
			type: "activity",
			room: GUIDE,
			typing: false,
			stoppable: false,
		});
		expect(state.rooms[GUIDE]?.outcome).toBe("failed");
		state = reduce(state, {
			type: "activity",
			room: GUIDE,
			typing: true,
			stoppable: true,
			phase: "thinking",
		});
		expect(state.rooms[GUIDE]?.outcome).toBeUndefined();
		expect(state.rooms[GUIDE]?.outcomeAt).toBeUndefined();
	});

	test("opening a room dismisses its failure", () => {
		const state = run([
			READY,
			{
				type: "activity",
				room: GUIDE,
				typing: false,
				stoppable: false,
				outcome: "failed",
				at: 5,
			},
			{ type: "focused", room: GUIDE },
		]);
		expect(state.rooms[GUIDE]?.outcome).toBeUndefined();
	});

	test("the room list brings the phase and the speaker of a turn already running", () => {
		const state = run([
			READY,
			{
				type: "rooms_loaded",
				rooms: [
					view(GUIDE, { typing: true, phase: "working", agent: "scout" }),
				],
			},
		]);
		expect(state.rooms[GUIDE]?.phase).toBe("working");
		expect(state.rooms[GUIDE]?.agent).toBe("scout");
	});

	test("a presence frame replaces who is busy, per agent", () => {
		let state = run([
			READY,
			{
				type: "presence",
				agents: { guide: { busy: true }, scout: { busy: false } },
			},
		]);
		expect(state.presence.guide?.busy).toBe(true);
		expect(state.presence.scout?.busy).toBe(false);
		state = reduce(state, {
			type: "presence",
			agents: { scout: { busy: true } },
		});
		expect(state.presence).toEqual({ scout: { busy: true } });
	});

	test("rooms keep the character the list gave them", () => {
		const character = { v: 1 } as unknown as NonNullable<RoomView["character"]>;
		const state = run([
			READY,
			{ type: "rooms_loaded", rooms: [view(GUIDE, { character })] },
		]);
		expect(state.rooms[GUIDE]?.view?.character).toBe(character);
	});
});

describe("cards the history brings", () => {
	const closed = (
		id: string,
		room: string,
		at: string,
		over: Partial<ClosedCard> = {},
	): ClosedCard => ({
		room,
		frame: approval(id, { at }),
		outcome: "approved",
		by: "Ada",
		closedAt: "2026-10-28T10:05:00.000Z",
		...over,
	});
	const at = (minute: number) =>
		`2026-10-28T10:${String(minute).padStart(2, "0")}:00.000Z`;

	test("a card that ended before the reload stands among the messages with how it ended", () => {
		const state = run([
			READY,
			{
				type: "history_loaded",
				room: SCOUT,
				messages: [
					message(1, SCOUT, { at: at(0) }),
					message(2, SCOUT, { at: at(3) }),
				],
				more: false,
				older: false,
				cards: [
					closed("p1", SCOUT, at(1), {
						outcome: "answered",
						answer: { kind: "ask", answer: { choices: ["red"], text: "dark" } },
					}),
				],
			},
		]);
		expect(
			timeline(state, SCOUT).map((item) =>
				item.kind === "message" ? item.message.id : item.kind,
			),
		).toEqual([1, "card", 2]);
		expect(state.cards.p1).toMatchObject({
			room: SCOUT,
			outcome: "answered",
			by: "Ada",
			answer: { kind: "ask", answer: { choices: ["red"], text: "dark" } },
			closedAt: "2026-10-28T10:05:00.000Z",
		});
		// It is a record, not a card that waits.
		expect(waitingCards(state, SCOUT)).toBe(0);
	});

	test("cards of an older page go in front of the ones held, and a page loaded twice does not double them", () => {
		const page = (cards: ClosedCard[], older: boolean) =>
			({
				type: "history_loaded",
				room: SCOUT,
				messages: older
					? [message(1, SCOUT, { at: at(0) })]
					: [message(5, SCOUT, { at: at(10) })],
				more: older ? false : true,
				older,
				cards,
			}) as const;
		let state = run([
			READY,
			page([closed("late", SCOUT, at(11))], false),
			page([closed("early", SCOUT, at(1))], true),
		]);
		state = reduce(state, page([closed("early", SCOUT, at(1))], true));
		expect(state.cardOrder).toEqual(["early", "late"]);
		expect(
			timeline(state, SCOUT).map((item) =>
				item.kind === "message"
					? item.message.id
					: item.kind === "card"
						? item.id
						: item.kind,
			),
		).toEqual([1, "early", 5, "late"]);
	});

	test("more than a page of ended cards are all kept in the room the page shows", () => {
		const cards = Array.from({ length: 40 }, (_, n) =>
			closed(
				`c${n}`,
				SCOUT,
				`2026-10-28T10:${String(n).padStart(2, "0")}:30.000Z`,
			),
		);
		const state = run([
			READY,
			{ type: "focused", room: SCOUT },
			{
				type: "history_loaded",
				room: SCOUT,
				messages: [message(1, SCOUT, { at: at(0) })],
				more: false,
				older: false,
				cards,
			},
		]);
		expect(state.cardOrder).toHaveLength(40);
	});

	test("a room the page stops showing gives up the cards before the messages it keeps", () => {
		const many = Array.from({ length: ROOM_PAGE + 10 }, (_, n) =>
			message(n + 1, SCOUT, {
				at: `2026-10-28T10:${String(Math.floor(n / 10)).padStart(2, "0")}:${String((n % 10) * 5).padStart(2, "0")}.000Z`,
			}),
		);
		const first = many[0] as RoomMessage;
		const kept = many[10] as RoomMessage;
		let state = run([
			READY,
			{ type: "focused", room: SCOUT },
			{
				type: "history_loaded",
				room: SCOUT,
				messages: many,
				more: false,
				older: false,
				cards: [
					closed("old", SCOUT, first.at),
					closed("new", SCOUT, "2026-10-28T11:30:00.000Z"),
				],
			},
		]);
		expect(state.cardOrder).toEqual(["old", "new"]);
		state = reduce(state, { type: "focused", room: undefined });
		expect(state.rooms[SCOUT]?.messages[0]?.id).toBe(kept.id);
		expect(state.rooms[SCOUT]?.more).toBe(true);
		// What stood before the kept page comes back with the older page.
		expect(state.cardOrder).toEqual(["new"]);
		expect(Object.keys(state.cards)).toEqual(["new"]);
	});

	test("the closing frame's answer, who and when stay on the card", () => {
		const state = run([
			READY,
			{ type: "prompt", room: SCOUT, prompt: approval("p1") },
			{
				type: "prompt_closed",
				prompt: "p1",
				outcome: "approved",
				by: "Bea",
				closedAt: "2026-10-28T10:05:00.000Z",
			},
		]);
		expect(state.cards.p1).toMatchObject({
			outcome: "approved",
			by: "Bea",
			closedAt: "2026-10-28T10:05:00.000Z",
		});
	});
});

describe("muting", () => {
	test("the room list carries a room's mute, and a mute the server took changes that room only", () => {
		let state = run([
			READY,
			{
				type: "rooms_loaded",
				rooms: [view(GUIDE, { muted: true }), view(SCOUT)],
			},
		]);
		expect(state.rooms[GUIDE]?.view?.muted).toBe(true);
		expect(state.rooms[SCOUT]?.view?.muted).toBeUndefined();
		state = reduce(state, { type: "room_muted", room: SCOUT, muted: true });
		expect(state.rooms[SCOUT]?.view?.muted).toBe(true);
		expect(state.rooms[GUIDE]?.view?.muted).toBe(true);
		state = reduce(state, { type: "room_muted", room: GUIDE, muted: false });
		expect(state.rooms[GUIDE]?.view?.muted).toBeUndefined();
		expect(state.rooms[SCOUT]?.view?.muted).toBe(true);
	});

	test("a mute for a room the page does not know, or one that is as told, changes nothing", () => {
		const state = run([READY, { type: "rooms_loaded", rooms: [view(GUIDE)] }]);
		expect(
			reduce(state, { type: "room_muted", room: SCOUT, muted: true }),
		).toBe(state);
		expect(
			reduce(state, { type: "room_muted", room: GUIDE, muted: false }),
		).toBe(state);
	});

	test("the next room list is what the server says", () => {
		let state = run([
			READY,
			{ type: "rooms_loaded", rooms: [view(GUIDE)] },
			{ type: "room_muted", room: GUIDE, muted: true },
		]);
		expect(state.rooms[GUIDE]?.view?.muted).toBe(true);
		state = reduce(state, { type: "rooms_loaded", rooms: [view(GUIDE)] });
		expect(state.rooms[GUIDE]?.view?.muted).toBeUndefined();
	});
});
