import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { RoomMessage, RoomView } from "../src/api-types.ts";
import { clearDrafts, draftOf, keepDraft } from "./lib/drafts.ts";
import {
	initialState,
	type RoomsState,
	reduce,
	switcherOrder,
} from "./lib/rooms.ts";
import {
	atScreenEdge,
	axisOf,
	drawerWidth,
	EDGE_GUARD,
	Swipe,
	settles,
} from "./lib/swipe.ts";

const VIEWPORT = 390;

describe("where a swipe may start", () => {
	test("a touch within 32 px of either screen edge is left to the system", () => {
		expect(EDGE_GUARD).toBe(32);
		expect(atScreenEdge(0, VIEWPORT)).toBe(true);
		expect(atScreenEdge(31, VIEWPORT)).toBe(true);
		expect(atScreenEdge(32, VIEWPORT)).toBe(false);
		expect(atScreenEdge(VIEWPORT - 32, VIEWPORT)).toBe(false);
		expect(atScreenEdge(VIEWPORT - 31, VIEWPORT)).toBe(true);
		expect(atScreenEdge(VIEWPORT, VIEWPORT)).toBe(true);
	});

	test("an edge start never becomes a drag, however far and straight it goes", () => {
		for (const x of [0, 20, 31, VIEWPORT - 31, VIEWPORT - 1]) {
			const swipe = new Swipe("closed", VIEWPORT);
			expect(swipe.begin(x, 300, 0)).toBe(false);
			expect(swipe.move(x + 200, 300, 100)).toEqual({
				state: "idle",
				progress: 0,
			});
			expect(swipe.finish()).toBeUndefined();
		}
	});

	test("the first point inside the guard starts a swipe", () => {
		expect(new Swipe("closed", VIEWPORT).begin(32, 300, 0)).toBe(true);
		expect(new Swipe("closed", VIEWPORT).begin(VIEWPORT - 32, 300, 0)).toBe(
			true,
		);
	});
});

describe("which motion counts", () => {
	test("it waits below 24 px, then needs |dx| > 1.5·|dy|", () => {
		expect(axisOf(23, 0)).toBe("wait");
		expect(axisOf(24, 0)).toBe("horizontal");
		expect(axisOf(-24, 0)).toBe("horizontal");
		expect(axisOf(25, 16)).toBe("horizontal");
		// Exactly 1.5 is not mostly horizontal; it waits for the motion to decide.
		expect(axisOf(24, 16)).toBe("wait");
		expect(axisOf(36, 24)).toBe("reject");
		expect(axisOf(40, 30)).toBe("reject");
		expect(axisOf(5, 30)).toBe("reject");
		expect(axisOf(10, 10)).toBe("wait");
	});

	test("a rightward swipe opens a closed drawer; a leftward one is no swipe of ours", () => {
		const right = new Swipe("closed", VIEWPORT);
		right.begin(100, 300, 0);
		expect(right.move(130, 302, 50).state).toBe("drag");
		const left = new Swipe("closed", VIEWPORT);
		left.begin(200, 300, 0);
		expect(left.move(160, 300, 50).state).toBe("reject");
		expect(left.finish()).toBeUndefined();
	});

	test("an open drawer is closed only by a leftward swipe", () => {
		const swipe = new Swipe("open", VIEWPORT);
		swipe.begin(200, 300, 0);
		expect(swipe.move(240, 300, 50).state).toBe("reject");
		const closing = new Swipe("open", VIEWPORT);
		closing.begin(200, 300, 0);
		expect(closing.move(160, 300, 50).state).toBe("drag");
	});

	test("once vertical motion wins, the swipe stays out even if it turns sideways later", () => {
		const swipe = new Swipe("closed", VIEWPORT);
		swipe.begin(100, 300, 0);
		expect(swipe.move(104, 340, 30).state).toBe("reject");
		expect(swipe.move(300, 340, 60).state).toBe("reject");
		expect(swipe.finish()).toBeUndefined();
	});
});

describe("following the finger and settling", () => {
	const width = drawerWidth(VIEWPORT);

	test("the drawer is 80 % of the screen, at most 360 px", () => {
		expect(drawerWidth(390)).toBe(312);
		expect(drawerWidth(1000)).toBe(360);
	});

	test("progress follows the finger across the drawer's width", () => {
		const swipe = new Swipe("closed", VIEWPORT);
		swipe.begin(100, 300, 0);
		expect(swipe.move(100 + width / 2, 300, 400).progress).toBeCloseTo(0.5, 2);
		expect(swipe.move(100 + width * 2, 300, 800).progress).toBe(1);
		const closing = new Swipe("open", VIEWPORT);
		closing.begin(250, 300, 0);
		expect(closing.move(250 - width / 4, 300, 400).progress).toBeCloseTo(
			0.75,
			2,
		);
	});

	test("it snaps open from 40 % on, or on a fast flick, and back otherwise", () => {
		expect(settles(0.39, 0)).toBe(false);
		expect(settles(0.4, 0)).toBe(true);
		expect(settles(0.1, 0.6)).toBe(true);
		expect(settles(0.9, -0.6)).toBe(false);
		expect(settles(0.5, -0.1)).toBe(true);
	});

	test("a slow drag past 40 % opens; a short slow one does not; a quick short flick does", () => {
		const slow = new Swipe("closed", VIEWPORT);
		slow.begin(100, 300, 0);
		slow.move(100 + width * 0.45, 300, 900);
		expect(slow.finish()).toBe(true);

		const short = new Swipe("closed", VIEWPORT);
		short.begin(100, 300, 0);
		short.move(100 + width * 0.3, 300, 900);
		expect(short.finish()).toBe(false);

		const flick = new Swipe("closed", VIEWPORT);
		flick.begin(100, 300, 0);
		flick.move(130, 300, 20);
		flick.move(160, 300, 40);
		expect(flick.finish()).toBe(true);
	});

	test("a finger that rests before it lifts is not flicking", () => {
		const swipe = new Swipe("closed", VIEWPORT);
		swipe.begin(100, 300, 0);
		swipe.move(130, 300, 20);
		swipe.move(160, 300, 40);
		expect(swipe.finish(60)).toBe(true);
		const rested = new Swipe("closed", VIEWPORT);
		rested.begin(100, 300, 0);
		rested.move(130, 300, 20);
		rested.move(160, 300, 40);
		expect(rested.finish(400)).toBe(false);
	});

	test("a drag that pauses before the finger lifts does not count its earlier speed", () => {
		const swipe = new Swipe("closed", VIEWPORT);
		swipe.begin(100, 300, 0);
		swipe.move(130, 300, 20);
		swipe.move(160, 300, 40);
		swipe.move(161, 300, 600);
		expect(swipe.finish()).toBe(false);
	});
});

const GUIDE = "app:agent.guide";
const SCOUT = "app:agent.scout";
const BUILD = "app:agent.build";
const TEAM = "app:group.team";
const THREAD = "app:thread.0b5e7c1a-0000-4000-8000-000000000001";

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

const said = (key: string, at: string): RoomMessage => ({
	id: 1,
	room: key,
	kind: "agent",
	author: "x",
	text: "hi",
	files: [],
	at,
});

const withRooms = (rooms: RoomView[]): RoomsState =>
	reduce(initialState(), { type: "rooms_loaded", rooms });

describe("the order of the drawer", () => {
	test("rooms with a waiting card come first, then the rest by latest activity", () => {
		let state = withRooms([
			view(GUIDE, { last: said(GUIDE, "2026-10-28T10:00:00.000Z") }),
			view(SCOUT, { last: said(SCOUT, "2026-10-28T12:00:00.000Z") }),
			view(BUILD, { last: said(BUILD, "2026-10-28T11:00:00.000Z") }),
			view(TEAM, { kind: "group" }),
		]);
		expect(switcherOrder(state)).toEqual([SCOUT, BUILD, GUIDE, TEAM]);
		state = reduce(state, {
			type: "prompt",
			room: GUIDE,
			prompt: {
				id: "p1",
				kind: "approval",
				title: "Send it?",
				message: "m",
				purpose: "action",
			} as never,
		});
		expect(switcherOrder(state)).toEqual([GUIDE, SCOUT, BUILD, TEAM]);
		// A card that ended no longer floats its room.
		state = reduce(state, {
			type: "prompt_closed",
			prompt: "p1",
			outcome: "approved",
		});
		expect(switcherOrder(state)).toEqual([SCOUT, BUILD, GUIDE, TEAM]);
	});

	test("rooms that wait for you keep their activity order among themselves; threads are not listed", () => {
		const prompt = (id: string) =>
			({
				id,
				kind: "approval",
				title: "t",
				message: "m",
				purpose: "action",
			}) as never;
		let state = withRooms([
			view(GUIDE, { last: said(GUIDE, "2026-10-28T10:00:00.000Z") }),
			view(SCOUT, { last: said(SCOUT, "2026-10-28T12:00:00.000Z") }),
			view(BUILD, { last: said(BUILD, "2026-10-28T11:00:00.000Z") }),
			view(THREAD, { kind: "thread", parent: GUIDE, readOnly: true }),
		]);
		state = reduce(state, { type: "prompt", room: GUIDE, prompt: prompt("a") });
		state = reduce(state, { type: "prompt", room: BUILD, prompt: prompt("b") });
		expect(switcherOrder(state)).toEqual([BUILD, GUIDE, SCOUT]);
	});
});

describe("drafts", () => {
	test("each room keeps its own unsent text, and an empty one is forgotten", () => {
		clearDrafts();
		keepDraft(GUIDE, "half a thought");
		keepDraft(SCOUT, "look at the disk");
		expect(draftOf(GUIDE)).toBe("half a thought");
		expect(draftOf(SCOUT)).toBe("look at the disk");
		expect(draftOf(BUILD)).toBe("");
		keepDraft(GUIDE, "");
		expect(draftOf(GUIDE)).toBe("");
		expect(draftOf(SCOUT)).toBe("look at the disk");
		clearDrafts();
	});
});

describe("reduced motion", () => {
	test("the drawer times its slide with the motion tokens, which the page sets to zero when less motion is asked for", () => {
		const css = readFileSync(new URL("./app.css", import.meta.url), "utf8");
		const block = css.slice(
			css.indexOf(".switcher {"),
			css.indexOf(".mode-banner {"),
		);
		const times = [...block.matchAll(/transition:[^;]*;/g)].map((m) => m[0]);
		expect(times.length).toBeGreaterThan(0);
		for (const line of times)
			expect(line).not.toMatch(/\d(ms|s)\b(?!\s+linear var)/);
		const tokens = readFileSync(
			new URL("./tokens.css", import.meta.url),
			"utf8",
		);
		expect(tokens).toMatch(
			/prefers-reduced-motion: reduce[\s\S]*--dur-slow: 0\.01ms/,
		);
	});
});
