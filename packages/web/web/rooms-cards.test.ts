import { describe, expect, test } from "bun:test";
import type { ServerFrame } from "../src/api-types.ts";
import { banner, reduce, timeline, waitingCards } from "./lib/rooms.ts";
import {
	approval,
	GUIDE,
	message,
	READY,
	run,
	SCOUT,
	view,
} from "./rooms-fixture.ts";

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

	test("a mode frame carries where an inherited mode comes from, and a later one without it drops it", () => {
		let state = run([READY, { type: "rooms_loaded", rooms: [view(SCOUT)] }]);
		state = reduce(state, {
			type: "mode",
			room: SCOUT,
			yolo: true,
			longRunning: false,
			inheritedFrom: "Guide",
		});
		expect(banner(state, SCOUT)).toEqual({
			yolo: true,
			longRunning: false,
			inheritedFrom: "Guide",
		});
		state = reduce(state, {
			type: "mode",
			room: SCOUT,
			yolo: true,
			longRunning: false,
		});
		expect(banner(state, SCOUT)).toEqual({ yolo: true, longRunning: false });
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
