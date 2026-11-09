import { expect, test } from "bun:test";
import { chipsOf, chipUnread, elsewhereUnread } from "./lib/chats-home.ts";
import type { Sections } from "./lib/sections.ts";

const A = "app:agent.a";
const B = "app:agent.b";
const C = "app:agent.c";
const D = "app:agent.d";
const HOME = "app:agent.guide";

/** The arrangement the home reads: Home and a pin on top, two folders, and the rest. */
const arrangement = (over: Partial<Sections> = {}): Sections => ({
	home: [HOME],
	pinned: [D],
	folders: [
		{ id: "f1", name: "Work", rooms: [A] },
		{ id: "f2", name: "Play", rooms: [] },
	],
	rest: [C, B],
	hidden: [],
	restAgents: [],
	restGroups: [],
	threads: {},
	orphans: { open: [], closed: [] },
	...over,
});
const times: Record<string, number> = { [A]: 40, [B]: 30, [C]: 20 };
const at = (key: string) => times[key] ?? Number.NEGATIVE_INFINITY;
const order = [HOME, A, B, C, D];

test("a chip counts the unread messages of its rooms", () => {
	const unread = { [A]: 2, [B]: 3, [C]: 0 };
	const chips = chipsOf(arrangement());
	expect(chips.map((chip) => chipUnread(chip, unread))).toEqual([5, 2, 0, 3]);
});

test("with a folder chip active, the unread rooms of the other folders and of none come first, newest first, each with its folder", () => {
	const unread = { [A]: 1, [B]: 2, [C]: 4 };
	const shape = arrangement({
		folders: [
			{ id: "f1", name: "Work", rooms: [A] },
			{ id: "f2", name: "Play", rooms: [B] },
		],
		rest: [C],
	});
	expect(elsewhereUnread(shape, "f2", unread, at, order)).toEqual([
		{ key: A, folder: { id: "f1", name: "Work" } },
		{ key: C },
	]);
	// A read room drops back to its own folder; the active chip's own rooms and All list nothing here.
	expect(
		elsewhereUnread(shape, "f2", { [A]: 0, [B]: 2, [C]: 0 }, at, order),
	).toEqual([]);
	expect(elsewhereUnread(shape, "all", unread, at, order)).toEqual([]);
});
