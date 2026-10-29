import { expect, test } from "bun:test";
import type { FolderView, RoomView } from "../src/api-types.ts";
import {
	arranged,
	drawerGroups,
	muteState,
	type SectionsInput,
	sections,
} from "./lib/sections.ts";

const HOME = "app:agent.guide";
const A = "app:agent.a";
const B = "app:agent.b";
const C = "app:agent.c";
const TEAM = "app:group.team";
const T1 = "app:thread.00000000-0000-4000-8000-000000000001";
const T2 = "app:thread.00000000-0000-4000-8000-000000000002";

const view = (key: string, over: Partial<RoomView> = {}): RoomView => ({
	key,
	kind: key.includes(":group.") ? "group" : "agent",
	name: key.slice(key.indexOf(".") + 1),
	displayName: key.slice(key.indexOf(".") + 1),
	home: false,
	readOnly: false,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
	...over,
});

const input = (
	views: RoomView[],
	pins: string[] = [],
	folders: FolderView[] = [],
): SectionsInput => ({
	order: views.map((one) => one.key),
	rooms: Object.fromEntries(views.map((one) => [one.key, { view: one }])),
	pins,
	folders,
});

const TEAMROOMS = [
	view(HOME, { home: true }),
	view(A),
	view(B),
	view(C),
	view(TEAM),
];
/** Newest activity: C, then A, then TEAM; B and Home have none. */
const times: Record<string, number> = { [C]: 30, [A]: 20, [TEAM]: 10 };
const at = (key: string) => times[key] ?? Number.NEGATIVE_INFINITY;

test("with no layout, Home leads and the rest are listed by latest activity, agents and groups apart", () => {
	const result = sections(input(TEAMROOMS), at);
	expect(result.home).toEqual([HOME]);
	expect(result.pinned).toEqual([]);
	expect(result.folders).toEqual([]);
	expect(result.rest).toEqual([C, A, TEAM, B]);
	expect(result.restAgents).toEqual([C, A, B]);
	expect(result.restGroups).toEqual([TEAM]);
	expect(arranged(result)).toBe(false);
});

test("pinned rooms keep the owners' order, then folders in theirs, then the rest by activity", () => {
	const result = sections(
		input(
			TEAMROOMS,
			[B, A],
			[
				{ id: "f2", name: "Two", rooms: [] },
				{ id: "f1", name: "One", rooms: [TEAM, C] },
			],
		),
		at,
	);
	expect(result.pinned).toEqual([B, A]);
	expect(result.folders).toEqual([
		{ id: "f2", name: "Two", rooms: [] },
		{ id: "f1", name: "One", rooms: [TEAM, C] },
	]);
	expect(result.rest).toEqual([]);
	expect(arranged(result)).toBe(true);
	// A room not placed lands in the rest at its activity place.
	const partial = sections(
		input(TEAMROOMS, [A], [{ id: "f1", name: "One", rooms: [TEAM] }]),
		at,
	);
	expect(partial.rest).toEqual([C, B]);
});

test("a deleted agent's key, Home, a thread and a repeat are left out of the layout", () => {
	const result = sections(
		input(
			[...TEAMROOMS, view(T1, { kind: "thread", parent: A, readOnly: true })],
			[A, "app:agent.deleted", HOME, T1, A],
			[{ id: "f1", name: "One", rooms: [A, B, "app:agent.deleted"] }],
		),
		at,
	);
	expect(result.pinned).toEqual([A]);
	expect(result.folders[0]?.rooms).toEqual([B]);
	expect(result.home).toEqual([HOME]);
});

test("a new room with no place is in the rest, and threads stay under their room wherever it sits", () => {
	const result = sections(
		input(
			[
				...TEAMROOMS,
				view(T1, { kind: "thread", parent: A, readOnly: true }),
				view(T2, {
					kind: "thread",
					parent: "app:agent.gone",
					readOnly: true,
					closed: true,
				}),
			],
			[],
			[{ id: "f1", name: "One", rooms: [A] }],
		),
		at,
	);
	expect(result.folders[0]?.rooms).toEqual([A]);
	expect(result.threads[A]).toEqual({ open: [T1], closed: [] });
	expect(result.orphans).toEqual({ open: [], closed: [T2] });
	expect(result.rest).toContain(C);
});

test("the drawer lists waiting rooms first, then pinned, folders and the rest, each room once", () => {
	const state = input(
		TEAMROOMS,
		[B],
		[{ id: "f1", name: "One", rooms: [TEAM, A] }],
	);
	const groups = drawerGroups(state, at, (key) => key === A || key === HOME);
	expect(groups).toEqual([
		{ id: "waiting", keys: [A, HOME] },
		{ id: "pinned", keys: [B] },
		{ id: "f1", title: "One", keys: [TEAM] },
		{ id: "rest", keys: [C] },
	]);
});

test("the drawer can keep the pinned list and the empty folders, for a lifted room to be dropped in", () => {
	const state = input(TEAMROOMS, [], [{ id: "f1", name: "One", rooms: [] }]);
	expect(drawerGroups(state, at, () => false).map((one) => one.id)).toEqual([
		"rest",
	]);
	expect(
		drawerGroups(state, at, () => false, true).map((one) => one.id),
	).toEqual(["pinned", "f1", "rest"]);
});

test("with no layout and nothing waiting the drawer is one run by latest activity, Home among them", () => {
	expect(drawerGroups(input(TEAMROOMS), at, () => false)).toEqual([
		{ id: "rest", keys: [C, A, TEAM, HOME, B] },
	]);
	// Threads are not listed.
	expect(
		drawerGroups(
			input([
				...TEAMROOMS,
				view(T1, { kind: "thread", parent: A, readOnly: true }),
			]),
			at,
			() => false,
		)[0]?.keys,
	).not.toContain(T1);
});

test("a folder's mute is none, some or all of its rooms, and an empty folder is none", () => {
	const muted = new Set([A, B]);
	const is = (key: string) => muted.has(key);
	expect(muteState([], is)).toBe("none");
	expect(muteState([C, TEAM], is)).toBe("none");
	expect(muteState([A, C], is)).toBe("some");
	expect(muteState([A, B], is)).toBe("all");
});
