import { expect, test } from "bun:test";
import type { RoomView } from "../src/api-types.ts";
import { neighbour, type OrderOptions, roomStops } from "./lib/room-order.ts";
import type { SectionsInput } from "./lib/sections.ts";

const F1 = "folder.00000000-0000-4000-8000-000000000001";
const F2 = "folder.00000000-0000-4000-8000-000000000002";

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

const thread = (key: string, parent: string, closed = false) =>
	view(key, { kind: "thread", parent, closed });

function input(
	views: RoomView[],
	layout: Partial<Pick<SectionsInput, "pins" | "folders">> = {},
): SectionsInput {
	return {
		order: views.map((one) => one.key),
		rooms: Object.fromEntries(views.map((one) => [one.key, { view: one }])),
		pins: layout.pins ?? [],
		folders: layout.folders ?? [],
	};
}

const options = (over: Partial<OrderOptions> = {}): OrderOptions => ({
	at: () => 0,
	collapsed: new Set(),
	expanded: new Set(),
	current: undefined,
	...over,
});

const keys = (stops: { key: string }[]) => stops.map((stop) => stop.key);
const shown = (stops: { key: string; shown: boolean }[]) =>
	stops.filter((stop) => stop.shown).map((stop) => stop.key);

const HOME = "app:agent.home";
const A = "app:agent.a";
const B = "app:agent.b";
const C = "app:agent.c";
const G = "app:group.g";

test("with nothing arranged the list runs Home, the agents, then the groups, each room followed by its open threads", () => {
	const state = input([
		view(HOME, { home: true }),
		view(G),
		view(A),
		thread("app:thread.a1", A),
		view(B),
	]);
	expect(keys(roomStops(state, options()))).toEqual([
		HOME,
		A,
		"app:thread.a1",
		B,
		G,
	]);
});

test("the pinned rooms come next, then the folders in their order, then the rest by latest activity, and a room is listed once", () => {
	const state = input(
		[view(HOME, { home: true }), view(A), view(B), view(C), view(G)],
		{
			pins: [C],
			folders: [
				{ id: F1, name: "One", rooms: [G, C] },
				{ id: F2, name: "Two", rooms: [A] },
			],
		},
	);
	const activity: Record<string, number> = { [B]: 5 };
	const stops = roomStops(
		state,
		options({ at: (key) => activity[key] ?? Number.NEGATIVE_INFINITY }),
	);
	expect(keys(stops)).toEqual([HOME, C, G, A, B]);
});

test("a folded folder's rooms are not shown, unless the open room is in it", () => {
	const state = input([view(HOME, { home: true }), view(A), view(B), view(C)], {
		folders: [{ id: F1, name: "One", rooms: [A, B] }],
	});
	const collapsed = new Set([F1]);
	expect(shown(roomStops(state, options({ collapsed })))).toEqual([HOME, C]);
	expect(shown(roomStops(state, options({ collapsed, current: B })))).toEqual([
		HOME,
		A,
		B,
		C,
	]);
	// Folded or not, every room is in the run.
	expect(keys(roomStops(state, options({ collapsed })))).toEqual([
		HOME,
		A,
		B,
		C,
	]);
});

test("finished threads show only while their fold is open or one of them is the open room; open threads always do", () => {
	const state = input([
		view(HOME, { home: true }),
		view(A),
		thread("app:thread.open", A),
		thread("app:thread.done", A, true),
		thread("app:thread.done2", A, true),
	]);
	expect(shown(roomStops(state, options()))).toEqual([
		HOME,
		A,
		"app:thread.open",
	]);
	expect(
		shown(
			roomStops(state, options({ expanded: new Set(["app:thread.done"]) })),
		),
	).toEqual([HOME, A, "app:thread.open", "app:thread.done"]);
	expect(
		shown(roomStops(state, options({ current: "app:thread.done2" }))),
	).toEqual([HOME, A, "app:thread.open", "app:thread.done2"]);
});

test("threads whose room is gone stand last", () => {
	const state = input([
		view(HOME, { home: true }),
		thread("app:thread.lost", "app:agent.gone"),
		view(A),
	]);
	expect(keys(roomStops(state, options()))).toEqual([
		HOME,
		A,
		"app:thread.lost",
	]);
});

const stops = (list: string[], hidden: string[] = []) =>
	list.map((key) => ({ key, shown: !hidden.includes(key) }));
const seen = (stop: { shown: boolean }) => stop.shown;

test("the neighbour is the next shown room in the direction, and the run does not wrap", () => {
	const run = stops(["a", "b", "c", "d"], ["c"]);
	expect(neighbour(run, "b", 1, seen)).toBe("d");
	expect(neighbour(run, "d", -1, seen)).toBe("b");
	expect(neighbour(run, "d", 1, seen)).toBeUndefined();
	expect(neighbour(run, "a", -1, seen)).toBeUndefined();
});

test("with no open room the run starts from its end, and an open room the run does not hold has no neighbour", () => {
	const run = stops(["a", "b", "c"]);
	expect(neighbour(run, undefined, 1, seen)).toBe("a");
	expect(neighbour(run, undefined, -1, seen)).toBe("c");
	expect(neighbour(run, "elsewhere", 1, seen)).toBeUndefined();
});

test("the unread neighbour steps over rooms that have none, folded ones included", () => {
	const run = stops(["a", "b", "c", "d", "e"], ["d"]);
	const unread = new Set(["b", "d", "e"]);
	const has = (stop: { key: string }) => unread.has(stop.key);
	expect(neighbour(run, "a", 1, has)).toBe("b");
	expect(neighbour(run, "b", 1, has)).toBe("d");
	expect(neighbour(run, "e", -1, has)).toBe("d");
	expect(neighbour(run, "b", -1, has)).toBeUndefined();
	expect(neighbour(run, "c", 1, has)).toBe("d");
});

test("a knight's temp knights are stops right after it, as the server lists them before the threads, and follow its fold", () => {
	const a = "app:agent.a";
	const helper = view("app:agent.a-1", {
		helper: { parent: a, parentName: "a" },
	});
	const t1 = "app:thread.00000000-0000-4000-8000-000000000001";
	const stops = roomStops(
		input(
			[view("app:agent.h", { home: true }), view(a), helper, thread(t1, a)],
			{ folders: [{ id: F1, name: "Work", rooms: [a] }] },
		),
		options({ collapsed: new Set([F1]) }),
	);
	expect(keys(stops)).toEqual(["app:agent.h", a, helper.key, t1]);
	expect(shown(stops)).toEqual(["app:agent.h"]);
});
