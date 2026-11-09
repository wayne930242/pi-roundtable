import { describe, expect, test } from "bun:test";
import type { RoomView, ServerFrame } from "../src/api-types.ts";
import { START_OVER_TEXT } from "../src/api-types.ts";
import { boxCards, currentLine } from "./lib/dialogue.ts";
import { lastMessage, reduce } from "./lib/rooms.ts";
import {
	approval,
	GUIDE,
	message,
	READY,
	run,
	SCOUT,
	view,
} from "./rooms-fixture.ts";

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

describe("the gate", () => {
	const STEP = {
		id: "name",
		label: "Name",
		required: true,
		open: { page: "profile" },
	};

	test("a ready that carries steps closes the app on them, and a ready without any opens it", () => {
		let state = run([{ ...READY, gate: [STEP] } as ServerFrame]);
		expect(state.gate).toEqual([STEP]);
		state = run([READY], state);
		expect(state.gate).toEqual([]);
	});

	test("a gate frame replaces the steps owed, and an empty one opens the app", () => {
		let state = run([READY]);
		state = run([{ type: "gate", steps: [STEP] } as ServerFrame], state);
		expect(state.gate).toEqual([STEP]);
		state = run([{ type: "gate", steps: [] } as ServerFrame], state);
		expect(state.gate).toEqual([]);
	});

	test("the frames of host rooms and notices leave an owner's state as it was", () => {
		const before = run([READY]);
		const after = run(
			[
				{ type: "host_card", room: "case:1" },
				{ type: "list_changed", kind: "case" },
				{ type: "page_changed", page: "crm" },
				{ type: "badge", count: 2 },
			] as unknown as ServerFrame[],
			before,
		);
		expect(after).toEqual(before);
	});
});

describe("a group's round", () => {
	const CREW = "app:group.crew";
	const crew = (over: Partial<RoomView> = {}) =>
		view(CREW, { kind: "group", members: ["guide", "scout"], ...over });
	const running = {
		id: 4,
		state: "running" as const,
		current: "guide",
		next: ["scout"],
		spoken: [],
		replies: 0,
		limit: 8,
	};
	const ended = {
		...running,
		state: "ended" as const,
		next: [],
		spoken: ["guide", "scout"],
		replies: 2,
		ended: "done" as const,
	};

	test("a round frame is kept on its room and replaced by the next one", () => {
		const state = run([
			{ type: "rooms_loaded", rooms: [view(GUIDE), crew()] },
			{ type: "round", room: CREW, round: running },
		]);
		expect(state.rooms[CREW]?.round).toEqual(running);
		const after = reduce(state, { type: "round", room: CREW, round: ended });
		expect(after.rooms[CREW]?.round).toEqual(ended);
		expect(after.rooms[GUIDE]?.round).toBeUndefined();
	});

	test("the room list brings a round already running; one that ended stays in the page, and a running one the list no longer has goes", () => {
		const opened = run([
			{ type: "rooms_loaded", rooms: [view(GUIDE), crew({ round: running })] },
		]);
		expect(opened.rooms[CREW]?.round).toEqual(running);
		// the server has none running now: the page's memory of a running round was stale
		const stale = reduce(opened, {
			type: "rooms_loaded",
			rooms: [view(GUIDE), crew()],
		});
		expect(stale.rooms[CREW]?.round).toBeUndefined();
		// a round that ended is only in the page, so the next list leaves it
		const done = run(
			[
				{ type: "round", room: CREW, round: ended },
				{ type: "rooms_loaded", rooms: [view(GUIDE), crew()] },
			],
			opened,
		);
		expect(done.rooms[CREW]?.round).toEqual(ended);
	});
});

describe("start over", () => {
	const line = (id: number, room = SCOUT) =>
		message(id, room, {
			kind: "system",
			text: START_OVER_TEXT,
			author: "Assistant",
		});

	test("the start-over line clears the room on every page: older messages and ended cards go, open ones stay", () => {
		let state = run([
			READY,
			{
				type: "history_loaded",
				room: SCOUT,
				messages: [message(1, SCOUT), message(2, SCOUT)],
				more: true,
				older: false,
			},
			{ type: "prompt", room: SCOUT, prompt: approval("old") },
			{ type: "prompt_closed", prompt: "old", outcome: "approved" },
			{ type: "prompt", room: SCOUT, prompt: approval("open") },
			{ type: "message", room: GUIDE, message: message(3, GUIDE) },
		]);
		state = reduce(state, { type: "message", room: SCOUT, message: line(4) });
		const room = state.rooms[SCOUT];
		expect(room?.messages.map((m) => m.id)).toEqual([4]);
		expect(room?.more).toBe(false);
		expect(state.cards.old).toBeUndefined();
		expect(state.cards.open).toBeDefined();
		// Another room keeps what it holds.
		expect(state.rooms[GUIDE]?.messages.map((m) => m.id)).toEqual([3]);
		// What is said next follows the line.
		state = reduce(state, {
			type: "message",
			room: SCOUT,
			message: message(5, SCOUT),
		});
		expect(state.rooms[SCOUT]?.messages.map((m) => m.id)).toEqual([4, 5]);
	});

	test("a reload's page that starts at the line drops what the page held from before it", () => {
		let state = run([
			READY,
			{
				type: "history_loaded",
				room: SCOUT,
				messages: [message(1, SCOUT), message(2, SCOUT)],
				more: true,
				older: false,
			},
		]);
		state = reduce(state, {
			type: "history_loaded",
			room: SCOUT,
			messages: [line(4), message(5, SCOUT)],
			more: false,
			older: false,
		});
		expect(state.rooms[SCOUT]?.messages.map((m) => m.id)).toEqual([4, 5]);
		expect(state.rooms[SCOUT]?.more).toBe(false);
	});

	test("the council's dialogue box empties with the room", () => {
		let state = run([
			READY,
			{
				type: "history_loaded",
				room: SCOUT,
				messages: [message(1, SCOUT)],
				more: false,
				older: false,
			},
			{ type: "prompt", room: SCOUT, prompt: approval("old") },
			{ type: "prompt_closed", prompt: "old", outcome: "approved" },
		]);
		expect(
			currentLine(state.rooms[SCOUT], "Ada", (a) => a ?? ""),
		).toBeDefined();
		state = reduce(state, { type: "message", room: SCOUT, message: line(2) });
		expect(
			currentLine(state.rooms[SCOUT], "Ada", (a) => a ?? ""),
		).toBeUndefined();
		expect(boxCards(state, SCOUT)).toEqual([]);
		expect(lastMessage(state, SCOUT)?.id).toBe(2);
	});
});
