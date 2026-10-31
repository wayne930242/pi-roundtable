import { describe, expect, test } from "bun:test";
import type { RoomMessage } from "../src/api-types.ts";
import {
	boxCards,
	createReveal,
	createStage,
	currentLine,
	followFocus,
	linePreview,
	REVEAL_CPS,
	resolveFocus,
	revealStep,
	sceneSpeaker,
	sliceChars,
	speakerOf,
	storedLine,
	voiceOf,
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
	reveal.feed("a", "\u5713\u684c😀\u9a0e\u58eb");
	expect(Array.from("\u5713\u684c😀\u9a0e\u58eb")).toHaveLength(5);
	reveal.step(1000 / REVEAL_CPS, false);
	expect(reveal.shown).toBe(1);
	expect(sliceChars("\u5713\u684c😀\u9a0e\u58eb", 3)).toBe("\u5713\u684c😀");
	expect(sliceChars("\u5713\u684c😀\u9a0e\u58eb", 99)).toBe(
		"\u5713\u684c😀\u9a0e\u58eb",
	);
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

test("the camera follows the member who spoke last, and rests on the ring while the owner speaks", () => {
	const members = ["lena", "otto"];
	expect(speakerOf({ who: "agent", agent: "otto" }, members)).toBe("otto");
	expect(speakerOf({ who: "owner" }, members)).toBeNull();
	expect(speakerOf({ who: "agent", agent: "ghost" }, members)).toBeNull();
	expect(speakerOf({ who: "agent", agent: undefined }, members)).toBeNull();
	expect(speakerOf(undefined, members)).toBeNull();
});

test("a seat the person turned to holds only while the line they looked at stands", () => {
	expect(followFocus("lena", "m5", undefined)).toBe("lena");
	expect(followFocus("lena", "m5", { lineId: "m5", member: "otto" })).toBe(
		"otto",
	);
	// they chose the whole ring: that holds too
	expect(followFocus("lena", "m5", { lineId: "m5", member: null })).toBeNull();
	// a new line ends it
	expect(followFocus("otto", "m6", { lineId: "m5", member: "lena" })).toBe(
		"otto",
	);
});

describe("linePreview", () => {
	test("the folded box shows the first line of words, without Markdown's marks, cut short", () => {
		expect(
			linePreview("\n## Found **three** [leads](https://x.test)\nmore"),
		).toBe("Found three leads");
		expect(linePreview("> - `quoted` item")).toBe("quoted item");
		expect(
			linePreview("\u7246\u5df2\u7d93\u780c\u597d\u4e86\u3002".repeat(20), 10),
		).toBe("\u7246\u5df2\u7d93\u780c\u597d\u4e86\u3002\u7246\u5df2…");
		expect(linePreview("")).toBe("");
	});
});

test("the box's voice is the agent whose words are being revealed or streamed, and nobody while the turn only thinks", () => {
	const stored = { who: "agent" as const, agent: "scout", live: false };
	const interim = { who: "agent" as const, agent: "scout", live: true };
	// typing out a stored reply, and done with it
	expect(voiceOf(stored, true, undefined)).toBe("scout");
	expect(voiceOf(stored, false, undefined)).toBeUndefined();
	// words streaming in name whoever writes them, even when the reveal has caught up
	expect(voiceOf(interim, false, "mason")).toBe("mason");
	// an interim line that stands while the turn runs its tools is not speech
	expect(voiceOf(interim, false, undefined)).toBeUndefined();
	// the owner's words, or nothing said, light nobody
	expect(
		voiceOf({ who: "owner", agent: undefined, live: false }, true, "scout"),
	).toBeUndefined();
	expect(voiceOf(undefined, true, "scout")).toBeUndefined();
});

describe("the stage: one speaker's words typed out whole before the next takes the box", () => {
	const members = ["lena", "otto", "mira"];
	const knight = (id: number, agent: string, text = `line ${id}`) =>
		say(id, { room: "app:group.c", agent, author: agent, text });
	const shown = (stage: ReturnType<typeof createStage>) => stage.line?.id;
	/** Types the line on show out at the box's pace, then gives the box on as the box does. */
	const typeOut = (stage: ReturnType<typeof createStage>, instant = false) => {
		const reveal = createReveal();
		const line = stage.line;
		reveal.feed(line?.id ?? "", line?.text ?? "");
		let steps = 0;
		while (!reveal.done) {
			reveal.step(16, instant);
			steps += 1;
		}
		stage.advance();
		return steps;
	};

	test("a knight who starts thinking while another's words type waits on its seat; the camera follows once they stand", () => {
		const stage = createStage();
		stage.feed([], undefined);
		const otto = [knight(1, "otto", "x".repeat(200))];
		stage.feed(otto, storedLineOf(otto));
		// lena's turn starts: no words yet, the round says she speaks
		stage.feed(otto, storedLineOf(otto));
		const reveal = createReveal();
		reveal.feed(stage.line?.id ?? "", stage.line?.text ?? "");
		reveal.step(100, false);
		expect(shown(stage)).toBe("m1");
		// while otto's words type, otto is the voice and holds the camera over lena, who thinks
		const voice = voiceOf(stage.line, !reveal.done, undefined);
		expect(voice).toBe("otto");
		expect(sceneSpeaker(voice, "lena", stage.line, members)).toBe("otto");
		reveal.finish();
		// typed out, nothing waits: the camera turns to lena, thinking
		expect(stage.advance()).toBe(false);
		const after = voiceOf(stage.line, !reveal.done, undefined);
		expect(after).toBeUndefined();
		expect(sceneSpeaker(after, "lena", stage.line, members)).toBe("lena");
	});

	test("lines said while one types wait and come in the order they were said, a stream settling in place", () => {
		const stage = createStage();
		const log = [knight(1, "otto")];
		stage.feed(log, storedLineOf(log));
		// lena streams, then her reply is stored, then mira replies, all while otto still types
		const stream = {
			...storedLineOf([knight(1, "lena", "Half")]),
			id: "s1",
			live: true,
		};
		stage.feed(log, stream);
		log.push(knight(2, "lena", "Half and whole"));
		log.push(knight(3, "mira"));
		stage.feed(log, storedLineOf(log));
		stage.feed(log, storedLineOf(log));
		expect(shown(stage)).toBe("m1");
		expect(stage.waiting).toBe(2);
		typeOut(stage);
		expect(stage.line).toMatchObject({ id: "m2", text: "Half and whole" });
		typeOut(stage);
		expect(shown(stage)).toBe("m3");
		expect(stage.advance()).toBe(false);
	});

	test("a tap shows the whole line and gives the box to the next at once", () => {
		const stage = createStage();
		const log = [knight(1, "otto", "y".repeat(500))];
		stage.feed(log, storedLineOf(log));
		log.push(knight(2, "lena"));
		stage.feed(log, storedLineOf(log));
		const reveal = createReveal();
		reveal.feed(stage.line?.id ?? "", stage.line?.text ?? "");
		reveal.step(16, false);
		expect(reveal.done).toBe(false);
		reveal.finish();
		expect(reveal.done).toBe(true);
		expect(stage.advance()).toBe(true);
		expect(shown(stage)).toBe("m2");
	});

	test("with reduced motion each line shows whole at once and the next follows straight away", () => {
		const stage = createStage();
		const log = [knight(1, "otto", "z".repeat(500))];
		stage.feed(log, storedLineOf(log));
		log.push(knight(2, "lena", "z".repeat(500)));
		stage.feed(log, storedLineOf(log));
		expect(typeOut(stage, true)).toBe(1);
		expect(shown(stage)).toBe("m2");
		expect(voiceOf(stage.line, false, undefined)).toBeUndefined();
	});

	test("the history a page loads does not replay, and the owner's send settles into its stored message", () => {
		const stage = createStage();
		stage.feed([], undefined);
		const log = [knight(1, "otto"), knight(2, "lena"), knight(3, "mira")];
		stage.feed(log, storedLineOf(log));
		expect(shown(stage)).toBe("m3");
		expect(stage.waiting).toBe(0);
		const send = {
			...storedLineOf([say(4, { kind: "owner", text: "go on" })]),
			id: "p9",
			pending: true,
		};
		stage.feed(log, send);
		log.push(say(4, { kind: "owner", author: "You", text: "go on" }));
		stage.feed(log, storedLineOf(log));
		expect(stage.waiting).toBe(1);
		stage.advance();
		expect(shown(stage)).toBe("m4");
	});
});

const storedLineOf = (log: RoomMessage[]) => {
	const last = log.at(-1);
	if (!last) throw new Error("empty log");
	return storedLine(last);
};
