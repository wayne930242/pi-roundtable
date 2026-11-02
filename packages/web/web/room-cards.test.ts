import { expect, test } from "bun:test";
import type { PromptFrame, RoomMessage, RoomView } from "../src/api-types.ts";
import { boxCards } from "./lib/dialogue.ts";
import { hangsUnder, roomCards, roomWaiting } from "./lib/room-surface.ts";
import {
	type Action,
	initialState,
	type RoomsState,
	reduce,
	timeline,
	waitingCards,
} from "./lib/rooms.ts";

const CREW = "app:group.crew";
const SCOUT = "app:agent.scout";
const THREAD = "app:thread.0b5e7c1a-0000-4000-8000-000000000001";
const HELPER = "app:agent.scout-helper-1";
const HELPER_THREAD = "app:thread.0b5e7c1a-0000-4000-8000-000000000002";

const view = (key: string, over: Partial<RoomView> = {}): RoomView => ({
	key,
	kind: "agent",
	name: key.slice(key.indexOf(".") + 1),
	displayName: key.slice(key.indexOf(".") + 1),
	home: false,
	readOnly: false,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
	...over,
});

const ROOMS: RoomView[] = [
	view(CREW, { kind: "group", displayName: "Crew", members: ["scout"] }),
	view(SCOUT, { displayName: "Scout" }),
	view(THREAD, {
		kind: "thread",
		displayName: "Coding #12",
		parent: CREW,
		readOnly: true,
	}),
	view(HELPER, {
		displayName: "Scout's helper",
		helper: { parent: SCOUT, parentName: "Scout" },
	}),
	view(HELPER_THREAD, {
		kind: "thread",
		displayName: "Coding #13",
		parent: HELPER,
		readOnly: true,
	}),
];

const said = (id: number, room: string, at: string): RoomMessage => ({
	id,
	room,
	kind: "agent",
	agent: "scout",
	author: "Scout",
	text: `message ${id}`,
	files: [],
	at,
});

const approval = (id: string, at: string): PromptFrame => ({
	id,
	at,
	kind: "approval",
	title: "Commit the changes?",
	message: "31 removed imports",
	purpose: "action",
});

const run = (actions: Action[], from: RoomsState = initialState()) =>
	actions.reduce(reduce, from);

const listed = (): RoomsState =>
	run([
		{ type: "rooms_loaded", rooms: ROOMS },
		{
			type: "history_loaded",
			room: CREW,
			messages: [said(1, CREW, "2026-11-02T10:00:00.000Z")],
			more: false,
			older: false,
		},
	]);

test("a card asked in a thread shows in the room the thread hangs under, marked with where it was asked", () => {
	const state = run(
		[
			{
				type: "prompt",
				room: THREAD,
				prompt: approval("commit", "2026-11-02T10:01:00.000Z"),
			},
		],
		listed(),
	);
	expect(roomCards(state, CREW)).toEqual([
		{ id: "commit", card: state.cards.commit as never, from: THREAD },
	]);
	expect(roomCards(state, THREAD)).toEqual([
		{ id: "commit", card: state.cards.commit as never },
	]);
	expect(roomWaiting(state, CREW)).toBe(1);
	// The room list counts it on the thread's own card under the room, not twice.
	expect(waitingCards(state, CREW)).toBe(0);
	expect(waitingCards(state, THREAD)).toBe(1);
	expect(roomCards(state, SCOUT)).toEqual([]);
	// The chat places it among the room's messages by when it opened, the scene's box shows it.
	expect(
		timeline(state, CREW).map((item) =>
			item.kind === "card" ? `card:${item.from}` : item.kind,
		),
	).toEqual(["message", `card:${THREAD}`]);
	expect(boxCards(state, CREW).map((entry) => entry.id)).toEqual(["commit"]);
});

test("a carried card stays answered until the room says something newer; its record stays in its thread", () => {
	let state = run(
		[
			{
				type: "prompt",
				room: THREAD,
				prompt: approval("commit", "2026-11-02T10:01:00.000Z"),
			},
			{
				type: "prompt_closed",
				prompt: "commit",
				outcome: "approved",
				by: "Ada",
				closedAt: "2026-11-02T10:02:00.000Z",
			},
		],
		listed(),
	);
	expect(roomCards(state, CREW).map((entry) => entry.card.outcome)).toEqual([
		"approved",
	]);
	expect(roomWaiting(state, CREW)).toBe(0);
	state = reduce(state, {
		type: "message",
		room: CREW,
		message: said(2, CREW, "2026-11-02T10:03:00.000Z"),
	});
	expect(roomCards(state, CREW)).toEqual([]);
	expect(boxCards(state, CREW)).toEqual([]);
	expect(roomCards(state, THREAD).map((entry) => entry.id)).toEqual(["commit"]);
});

test("a card carries up through temp knights and their threads, and a loop of parents ends", () => {
	const state = run(
		[
			{
				type: "prompt",
				room: HELPER_THREAD,
				prompt: approval("deep", "2026-11-02T10:01:00.000Z"),
			},
		],
		listed(),
	);
	expect(hangsUnder(state, HELPER_THREAD, SCOUT)).toBe(true);
	expect(roomCards(state, SCOUT).map((entry) => entry.from)).toEqual([
		HELPER_THREAD,
	]);
	expect(roomCards(state, HELPER).map((entry) => entry.from)).toEqual([
		HELPER_THREAD,
	]);
	// A temp knight made in its knight's own room hangs under that room, not under a group the knight sits in.
	expect(roomCards(state, CREW)).toEqual([]);

	const looped = run(
		[
			{
				type: "rooms_loaded",
				rooms: [
					view("app:thread.a", { kind: "thread", parent: "app:thread.b" }),
					view("app:thread.b", { kind: "thread", parent: "app:thread.a" }),
				],
			},
		],
		initialState(),
	);
	expect(hangsUnder(looped, "app:thread.a", CREW)).toBe(false);
});

test("a card whose thread the room list has not brought yet shows in that thread only", () => {
	const state = run(
		[
			{
				type: "prompt",
				room: "app:thread.unlisted",
				prompt: approval("early", "2026-11-02T10:01:00.000Z"),
			},
		],
		listed(),
	);
	expect(roomCards(state, CREW)).toEqual([]);
	expect(roomCards(state, "app:thread.unlisted")).toHaveLength(1);
});

test("a carried card without a time stands at the end and holds none of the room's own cards back", () => {
	const untimed: PromptFrame = {
		id: "untimed",
		kind: "approval",
		title: "Old frame",
		message: "",
		purpose: "action",
	};
	const state = run(
		[
			{
				type: "history_loaded",
				room: CREW,
				messages: [
					said(1, CREW, "2026-11-02T10:00:00.000Z"),
					said(2, CREW, "2026-11-02T10:10:00.000Z"),
				],
				more: false,
				older: false,
			},
			{ type: "prompt", room: THREAD, prompt: untimed },
			{
				type: "prompt",
				room: CREW,
				prompt: approval("own", "2026-11-02T10:05:00.000Z"),
			},
		],
		listed(),
	);
	expect(
		timeline(state, CREW).map((item) =>
			item.kind === "card"
				? item.id
				: `m${item.kind === "message" ? item.message.id : "?"}`,
		),
	).toEqual(["m1", "own", "m2", "untimed"]);
});

test("an answered carried card does not show while the room has no message to measure it by", () => {
	const state = run([
		{ type: "rooms_loaded", rooms: ROOMS },
		{
			type: "prompt",
			room: THREAD,
			prompt: approval("old", "2025-01-01T10:00:00.000Z"),
		},
		{
			type: "prompt_closed",
			prompt: "old",
			outcome: "approved",
			closedAt: "2025-01-01T10:01:00.000Z",
		},
		{
			type: "prompt",
			room: THREAD,
			prompt: approval("open", "2026-11-02T10:01:00.000Z"),
		},
	]);
	expect(roomCards(state, CREW).map((entry) => entry.id)).toEqual(["open"]);
});

test("a temp knight made during a group's round hangs under the group's room, where its answer goes", () => {
	const state = run(
		[
			{
				type: "rooms_loaded",
				rooms: ROOMS.map((one) =>
					one.key === HELPER
						? {
								...one,
								helper: { parent: SCOUT, parentName: "Scout", origin: CREW },
							}
						: one,
				),
			},
			{
				type: "prompt",
				room: HELPER,
				prompt: approval("asked", "2026-11-02T10:01:00.000Z"),
			},
		],
		listed(),
	);
	expect(roomCards(state, CREW).map((entry) => entry.from)).toEqual([HELPER]);
	expect(roomCards(state, SCOUT)).toEqual([]);
	// The temp knight's own row in the list counts it.
	expect(waitingCards(state, HELPER)).toBe(1);
	expect(waitingCards(state, CREW)).toBe(0);
});

test("an answered thread card stays while the room above still shows it, however the thread trims its cards", () => {
	// The page shows the thread's latest page only, older messages left out, the card before them.
	let state = run(
		[
			{
				type: "prompt",
				room: THREAD,
				prompt: approval("commit", "2026-11-02T10:01:00.000Z"),
			},
			{
				type: "history_loaded",
				room: THREAD,
				messages: [said(9, THREAD, "2026-11-02T10:05:00.000Z")],
				more: true,
				older: false,
			},
			{ type: "focused", room: CREW },
			{
				type: "prompt_closed",
				prompt: "commit",
				outcome: "approved",
				closedAt: "2026-11-02T10:06:00.000Z",
			},
		],
		listed(),
	);
	expect(roomCards(state, CREW).map((entry) => entry.card.outcome)).toEqual([
		"approved",
	]);
	// Once the room above moves on, the thread's trimming takes it.
	state = reduce(state, {
		type: "message",
		room: CREW,
		message: said(2, CREW, "2026-11-02T10:07:00.000Z"),
	});
	state = reduce(state, {
		type: "message",
		room: THREAD,
		message: said(10, THREAD, "2026-11-02T10:08:00.000Z"),
	});
	expect(roomCards(state, CREW)).toEqual([]);
	expect(state.cards.commit).toBeUndefined();
});

test("a room's cards come in the order they opened, whatever order the page heard of them", () => {
	const state = run(
		[
			{
				type: "prompt",
				room: CREW,
				prompt: approval("later", "2026-11-02T10:05:00.000Z"),
			},
			{
				type: "prompt",
				room: THREAD,
				prompt: approval("earlier", "2026-11-02T10:02:00.000Z"),
			},
		],
		listed(),
	);
	expect(roomCards(state, CREW).map((entry) => entry.id)).toEqual([
		"earlier",
		"later",
	]);
	expect(
		timeline(state, CREW).flatMap((item) =>
			item.kind === "card" ? [item.id] : [],
		),
	).toEqual(["earlier", "later"]);
});
