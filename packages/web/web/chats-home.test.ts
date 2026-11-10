import { expect, test } from "bun:test";
import {
	chipsOf,
	listFor,
	pinBadge,
	pinSizeOf,
	pinsOf,
} from "./lib/chats-home.ts";
import type { Sections } from "./lib/sections.ts";

const A = "app:agent.a";
const B = "app:agent.b";
const C = "app:agent.c";
const D = "app:agent.d";
const HOME = "app:agent.guide";

/** The arrangement the home reads: Home, a pin, two folders, and the rest. */
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

test("the pins are the pinned rooms in their order; Home is not one of them", () => {
	expect(pinsOf(arrangement())).toEqual([D]);
	expect(pinsOf(arrangement({ pinned: [] }))).toEqual([]);
});

test("there are no chips without a folder; with folders: all, each folder, and others only when rooms are in none", () => {
	expect(chipsOf(arrangement({ folders: [] }))).toEqual([]);
	expect(chipsOf(arrangement()).map((chip) => [chip.id, chip.kind])).toEqual([
		["all", "all"],
		["f1", "folder"],
		["f2", "folder"],
		["other", "other"],
	]);
	expect(chipsOf(arrangement({ rest: [] })).map((chip) => chip.id)).toEqual([
		"all",
		"f1",
		"f2",
	]);
});

test("all lists Home first, then every room that is neither pinned nor hidden by latest activity; a folder chip lists its rooms by the same order", () => {
	expect(listFor(arrangement(), "all", at, order)).toEqual([HOME, A, B, C]);
	// Home leads even when every other room spoke later, and without folders too.
	const late = (key: string) => (key === HOME ? 0 : 100);
	expect(listFor(arrangement(), "all", late, order)[0]).toBe(HOME);
	expect(listFor(arrangement({ folders: [] }), "all", at, order)).toEqual([
		HOME,
		B,
		C,
	]);
	expect(listFor(arrangement(), "f1", at, order)).toEqual([A]);
	expect(listFor(arrangement(), "f2", at, order)).toEqual([]);
	expect(listFor(arrangement(), "other", at, order)).toEqual([B, C]);
	// A folder that is gone shows everything rather than nothing.
	expect(listFor(arrangement(), "folder.deleted", at, order)).toEqual([
		HOME,
		A,
		B,
		C,
	]);
	// A tie keeps the server's order.
	const flat = listFor(arrangement({ rest: [C, B] }), "all", () => 0, [
		B,
		C,
		A,
	]);
	expect(flat).toEqual([HOME, B, C, A]);
});

test("a folder's rooms are in the folder's chip even when the folder holds several, newest first", () => {
	const folders = [{ id: "f1", name: "Work", rooms: [B, A, C] }];
	expect(listFor(arrangement({ folders, rest: [] }), "f1", at, order)).toEqual([
		A,
		B,
		C,
	]);
});

test("a waiting card outranks unread, unread outranks the working dot, and nothing is no badge", () => {
	expect(pinBadge(2, 5, true)).toEqual({ kind: "waiting", count: 2 });
	expect(pinBadge(0, 5, true)).toEqual({ kind: "unread", count: 5 });
	expect(pinBadge(0, 0, true)).toEqual({ kind: "typing" });
	expect(pinBadge(0, 0, false)).toBeUndefined();
});

test("pins are 80 px in the phone home's dock, and 56 px in a column or beside an open room", () => {
	expect(pinSizeOf({ column: false, active: undefined })).toBe(80);
	expect(pinSizeOf({ column: true, active: undefined })).toBe(56);
	expect(pinSizeOf({ column: false, active: A })).toBe(56);
	expect(pinSizeOf({ column: true, active: A })).toBe(56);
});
