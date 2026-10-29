import { expect, test } from "bun:test";
import type { RoomMessage } from "../src/api-types.ts";
import {
	boxCards,
	createReveal,
	currentLine,
	REVEAL_CPS,
	resolveFocus,
	revealStep,
	sliceChars,
} from "./lib/dialogue.ts";
import type { CardState, RoomState } from "./lib/rooms.ts";

const say = (id: number, over: Partial<RoomMessage> = {}): RoomMessage => ({
	id,
	room: "app:agent.scout",
	kind: "agent",
	agent: "scout",
	author: "Scout",
	text: `line ${id}`,
	files: [],
	at: "2026-10-29T10:00:00.000Z",
	...over,
});

const room = (over: Partial<RoomState> = {}): RoomState => ({
	key: "app:agent.scout",
	messages: [],
	live: [],
	more: false,
	progress: { text: "", tools: [] },
	typing: false,
	stoppable: false,
	mode: { yolo: false, longRunning: false },
	autoApproved: 0,
	pending: [],
	...over,
});

const names = (agent: string | undefined) =>
	agent === "scout" ? "Scout" : (agent ?? "?");

test("the line is the newest thing said: a send waiting, then a stream, then an interim message, then the last stored words", () => {
	const messages = [
		say(1, { kind: "owner", agent: undefined, author: "Ada", text: "hi" }),
		say(2, { kind: "system", text: "Conversation started over" }),
		say(3, { text: "hello" }),
		say(4, { kind: "system", text: "Yolo mode approved: x" }),
	];
	const stored = currentLine(room({ messages }), "Ada", names);
	expect(stored).toMatchObject({
		id: "m3",
		who: "agent",
		text: "hello",
		live: false,
	});
	const interim = currentLine(
		room({ messages, live: [say(0, { text: "checking", live: "u1" })] }),
		"Ada",
		names,
	);
	expect(interim).toMatchObject({ id: "lu1", live: true, text: "checking" });
	const streaming = currentLine(
		room({
			messages,
			typing: true,
			progress: { text: "Working on it", tools: [] },
			agent: "scout",
		}),
		"Ada",
		names,
	);
	expect(streaming).toMatchObject({
		id: "s4",
		who: "agent",
		agent: "scout",
		author: "Scout",
		text: "Working on it",
		live: true,
	});
	const sending = currentLine(
		room({
			messages,
			pending: [{ id: "q1", room: "app:agent.scout", text: "next", files: [] }],
		}),
		"Ada",
		names,
	);
	expect(sending).toMatchObject({
		who: "owner",
		author: "Ada",
		text: "next",
		pending: true,
	});
	// a send the server refused is not the line: it shows in the log, where Try again lives
	const refused = currentLine(
		room({
			messages,
			pending: [
				{
					id: "q2",
					room: "app:agent.scout",
					text: "no",
					files: [],
					failed: "not_accepted",
				},
			],
		}),
		"Ada",
		names,
	);
	expect(refused?.id).toBe("m3");
	expect(currentLine(room(), "Ada", names)).toBeUndefined();
	expect(currentLine(undefined, "Ada", names)).toBeUndefined();
});

test("a streaming turn in a room of one agent is that agent's, in a group it is the member whose turn it is", () => {
	const streaming = room({ typing: true, progress: { text: "hm", tools: [] } });
	expect(currentLine(streaming, "Ada", names, "scout")?.author).toBe("Scout");
	expect(
		currentLine({ ...streaming, agent: "mason" }, "Ada", names, undefined),
	).toMatchObject({ agent: "mason", author: "mason" });
});

test("the words appear at a steady pace, all at once when asked, and never run past the text", () => {
	expect(revealStep(0, 100, 1000, { cps: 50 })).toBe(50);
	expect(revealStep(0, 100, 100)).toBeCloseTo(REVEAL_CPS * 0.1, 9);
	expect(revealStep(90, 100, 5000)).toBe(100);
	expect(revealStep(10, 100, 16, { instant: true })).toBe(100);
	// a clock that goes back never takes words away
	expect(revealStep(20, 100, -50)).toBe(20);
});

test("a stream keeps what already showed, a new line starts again, and a tap shows everything", () => {
	const reveal = createReveal();
	reveal.feed("s4", "Hello wor");
	reveal.step(1000, false);
	expect(reveal.shown).toBe(9);
	expect(reveal.done).toBe(true);
	// the same line grows
	reveal.feed("s4", "Hello world, and more");
	expect(reveal.shown).toBe(9);
	expect(reveal.done).toBe(false);
	// the stored reply that replaces the stream carries the same words: nothing is typed twice
	reveal.feed("m5", "Hello world, and more");
	expect(reveal.shown).toBe(9);
	// another line starts from nothing
	reveal.feed("m6", "Another thing");
	expect(reveal.shown).toBe(0);
	reveal.finish();
	expect(reveal.shown).toBe(13);
	expect(reveal.done).toBe(true);
});

test("characters are counted whole, so Chinese text and emoji are never cut in half", () => {
	const reveal = createReveal();
	reveal.feed("a", "圓桌😀騎士");
	expect(Array.from("圓桌😀騎士")).toHaveLength(5);
	reveal.step(1000 / REVEAL_CPS, false);
	expect(reveal.shown).toBe(1);
	expect(sliceChars("圓桌😀騎士", 3)).toBe("圓桌😀");
	expect(sliceChars("圓桌😀騎士", 99)).toBe("圓桌😀騎士");
});

test("the box answers the cards open now and the ones just answered, not the old ones", () => {
	const frame = (id: string) =>
		({
			id,
			kind: "approval",
			title: id,
			message: "",
			purpose: "action",
		}) as const;
	const card = (id: string, over: Partial<CardState>): CardState => ({
		room: "app:agent.scout",
		frame: frame(id),
		after: 0,
		...over,
	});
	const state = {
		cards: {
			old: card("old", { after: 3, outcome: "approved" }),
			fresh: card("fresh", { after: 7, outcome: "approved" }),
			open: card("open", { after: 2 }),
			other: card("other", { room: "app:agent.mason", after: 9 }),
		},
		cardOrder: ["old", "fresh", "open", "other"],
	};
	expect(
		boxCards(state, "app:agent.scout", 7).map((entry) => entry.id),
	).toEqual(["fresh", "open"]);
	expect(boxCards(state, "app:agent.scout", undefined)).toHaveLength(3);
});

test("a route key names an agent by its name or by the key of its room, and nobody else seated names nothing", () => {
	const roster = [
		{ key: "app:agent.guide", name: "guide" },
		{ key: "app:agent.scout", name: "scout" },
	];
	expect(resolveFocus("scout", roster)).toBe("scout");
	expect(resolveFocus("app:agent.guide", roster)).toBe("guide");
	expect(resolveFocus("ghost", roster)).toBeNull();
	expect(resolveFocus(undefined, roster)).toBeNull();
	expect(resolveFocus("", roster)).toBeNull();
});
