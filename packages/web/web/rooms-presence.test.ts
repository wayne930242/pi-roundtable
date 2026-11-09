import { describe, expect, test } from "bun:test";
import type { ClosedCard, RoomMessage, RoomView } from "../src/api-types.ts";
import { ROOM_PAGE, reduce, timeline, waitingCards } from "./lib/rooms.ts";
import {
	approval,
	GUIDE,
	message,
	READY,
	run,
	SCOUT,
	view,
} from "./rooms-fixture.ts";

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
