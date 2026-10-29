import { expect, test } from "bun:test";
import {
	beforeAt,
	editFor,
	type ItemBox,
	landing,
	resolveFolderDrop,
	resolveRoomDrop,
	scrollStep,
	shifts,
	type Zone,
	zoneAt,
} from "./lib/reorder.ts";
import type { Place } from "./lib/sections.ts";

const A = "app:agent.a";
const B = "app:agent.b";
const C = "app:agent.c";
const D = "app:agent.d";

const rows = (top: number, keys: string[]): ItemBox[] =>
	keys.map((key, i) => ({ key, top: top + i * 60, height: 56 }));

/** Pinned (A B) at 100..216, folder f1 (C) at 240..356 whose header is the first 40 px, folder f2 collapsed at 380..420, rest (D) at 440..500. */
const zones: Zone[] = [
	{
		id: "pinned",
		kind: "pinned",
		top: 100,
		bottom: 216,
		items: rows(100, [A, B]),
	},
	{
		id: "f1",
		kind: "folder",
		folder: "f1",
		top: 240,
		bottom: 356,
		items: rows(296, [C]),
	},
	{ id: "f2", kind: "folder", folder: "f2", top: 380, bottom: 420, items: [] },
	{ id: "rest", kind: "rest", top: 440, bottom: 500, items: rows(440, [D]) },
];

test("a finger is over the zone it is in, the nearest one in a gap, and none far outside", () => {
	expect(zoneAt(zones, 150)?.id).toBe("pinned");
	expect(zoneAt(zones, 228)?.id).toBe("pinned");
	expect(zoneAt(zones, 232)?.id).toBe("f1");
	expect(zoneAt(zones, 400)?.id).toBe("f2");
	expect(zoneAt(zones, 20)).toBeUndefined();
	expect(zoneAt(zones, 700)).toBeUndefined();
});

test("a row lands before the first row whose middle is below the finger, else last", () => {
	const row = rows(100, [A, B, C]);
	expect(beforeAt(row, C, 110)).toBe(A);
	expect(beforeAt(row, C, 140)).toBe(B);
	expect(beforeAt(row, C, 200)).toBeNull();
	// The dragged row is not a landmark for itself.
	expect(beforeAt(row, A, 110)).toBe(B);
});

test("a dragged room resolves to the zone under it and the neighbour it goes before", () => {
	expect(resolveRoomDrop(zones, C, 105)).toMatchObject({
		zone: { id: "pinned" },
		before: A,
	});
	expect(resolveRoomDrop(zones, C, 210)).toMatchObject({
		zone: { id: "pinned" },
		before: null,
	});
	// A collapsed folder takes the room last.
	expect(resolveRoomDrop(zones, A, 400)).toMatchObject({
		zone: { folder: "f2" },
		before: null,
	});
	expect(resolveRoomDrop(zones, A, 450)).toMatchObject({
		zone: { kind: "rest" },
	});
	// Outside every zone the drag is cancelled.
	expect(resolveRoomDrop(zones, A, 900)).toBeUndefined();
});

const pinned: Place = { kind: "pinned", siblings: [A, B] };
const inF1: Place = { kind: "folder", folder: "f1", siblings: [C] };
const loose: Place = { kind: "rest" };

test("a drop edits the layout only when the room would end up somewhere else", () => {
	const into = (id: string, before: string | null) => ({
		zone: zones.find((zone) => zone.id === id) as Zone,
		before,
	});
	// Within its own list: unchanged order is no edit, a real move is.
	expect(editFor(pinned, A, into("pinned", B))).toBeUndefined();
	expect(editFor(pinned, A, into("pinned", null))).toEqual({
		kind: "pin",
		before: null,
	});
	expect(editFor(pinned, B, into("pinned", A))).toEqual({
		kind: "pin",
		before: A,
	});
	// Between lists: into a folder, into pinned, and out to the rest.
	expect(editFor(pinned, A, into("f1", C))).toEqual({
		kind: "folder",
		folder: "f1",
		before: C,
	});
	expect(editFor(inF1, C, into("pinned", B))).toEqual({
		kind: "pin",
		before: B,
	});
	expect(editFor(inF1, C, into("rest", null))).toEqual({ kind: "unplace" });
	expect(editFor(pinned, A, into("rest", null))).toEqual({ kind: "unplace" });
	// A room of the rest dropped in the rest snaps back: that list is by activity.
	expect(editFor(loose, D, into("rest", null))).toBeUndefined();
	expect(editFor(loose, D, into("f2", null))).toEqual({
		kind: "folder",
		folder: "f2",
		before: null,
	});
	// The same folder, another place.
	expect(editFor(inF1, C, into("f1", null))).toBeUndefined();
});

test("a folder dragged by its header lands before the header below the finger, and is cancelled far outside", () => {
	const headers: ItemBox[] = [
		{ key: "f1", top: 240, height: 40 },
		{ key: "f2", top: 380, height: 40 },
		{ key: "f3", top: 440, height: 40 },
	];
	const bounds = { top: 240, bottom: 500 };
	expect(resolveFolderDrop(headers, bounds, "f3", 250)).toEqual({
		before: "f1",
	});
	expect(resolveFolderDrop(headers, bounds, "f3", 400)).toEqual({
		before: null,
	});
	expect(resolveFolderDrop(headers, bounds, "f3", 390)).toEqual({
		before: "f2",
	});
	expect(resolveFolderDrop(headers, bounds, "f1", 420)).toEqual({
		before: "f3",
	});
	expect(resolveFolderDrop(headers, bounds, "f1", 600)).toBeUndefined();
	expect(resolveFolderDrop(headers, bounds, "f1", 100)).toBeUndefined();
});

test("while one item is dragged to a new place the others in between move over by its height", () => {
	const boxes = rows(0, [A, B, C, D]);
	expect(shifts(boxes, 0, 2, 4)).toEqual([0, -60, -60, 0]);
	expect(shifts(boxes, 3, 1, 4)).toEqual([0, 60, 60, 0]);
	expect(shifts(boxes, 1, 1, 4)).toEqual([0, 0, 0, 0]);
	expect(landing([A, B, C, D], A, D)).toBe(2);
	expect(landing([A, B, C, D], D, A)).toBe(0);
	expect(landing([A, B, C, D], B, null)).toBe(3);
});

test("the view scrolls toward an edge the finger nears, faster the closer, and holds in the middle", () => {
	expect(scrollStep(300, 0, 600)).toBe(0);
	expect(scrollStep(10, 0, 600)).toBeLessThan(0);
	expect(scrollStep(590, 0, 600)).toBeGreaterThan(0);
	expect(Math.abs(scrollStep(2, 0, 600))).toBeGreaterThan(
		Math.abs(scrollStep(40, 0, 600)),
	);
	expect(scrollStep(-50, 0, 600)).toBe(-18);
});
