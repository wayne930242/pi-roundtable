import { expect, test } from "bun:test";
import type { LayoutView } from "./api-types.ts";
import {
	createFolder,
	EMPTY_LAYOUT,
	FOLDER_NAME_MAX,
	LayoutError,
	MAX_FOLDERS,
	moveBefore,
	nudgeBefore,
	placeFolder,
	placeRoom,
	removeFolder,
	renameFolder,
	setPinned,
	shown,
} from "./layout-order.ts";

const A = "app:agent.a";
const B = "app:agent.b";
const C = "app:agent.c";
const D = "app:agent.d";

const layout = (over: Partial<LayoutView> = {}): LayoutView => ({
	...EMPTY_LAYOUT,
	...over,
});
const problem = (run: () => unknown): string | undefined => {
	try {
		run();
	} catch (error) {
		return error instanceof LayoutError ? error.code : String(error);
	}
	return undefined;
};

test("moveBefore puts the item before a neighbour, at the end for none, and keeps it in place before itself", () => {
	expect(moveBefore([A, B, C], C, A)).toEqual([C, A, B]);
	expect(moveBefore([A, B, C], A, null)).toEqual([B, C, A]);
	expect(moveBefore([A, B, C], D, B)).toEqual([A, D, B, C]);
	// A neighbour that is not in the list (a stale key) leaves the item at the end.
	expect(moveBefore([A, B], D, "gone")).toEqual([A, B, D]);
	expect(moveBefore([A, B, C], B, B)).toEqual([A, B, C]);
	expect(moveBefore([A, B], C, C)).toEqual([A, B, C]);
});

test("nudgeBefore names the neighbour an item goes before, skipping nothing it was not shown", () => {
	expect(nudgeBefore([A, B, C], B, "up")).toEqual({ before: A });
	expect(nudgeBefore([A, B, C], B, "down")).toEqual({ before: null });
	expect(nudgeBefore([A, B, C, D], B, "down")).toEqual({ before: D });
	expect(nudgeBefore([A, B, C], A, "up")).toBeUndefined();
	expect(nudgeBefore([A, B, C], C, "down")).toBeUndefined();
	expect(nudgeBefore([A, B, C], D, "up")).toBeUndefined();
});

test("a folder is made with a trimmed name; empty, long, controlled, duplicate and the 51st are refused", () => {
	const made = createFolder(layout(), "folder.1", "  Work  ");
	expect(made.folders).toEqual([{ id: "folder.1", name: "Work", rooms: [] }]);
	expect(problem(() => createFolder(layout(), "folder.1", "   "))).toBe(
		"bad-name",
	);
	expect(
		problem(() =>
			createFolder(layout(), "folder.1", "x".repeat(FOLDER_NAME_MAX + 1)),
		),
	).toBe("bad-name");
	expect(() =>
		createFolder(layout(), "folder.1", "x".repeat(FOLDER_NAME_MAX)),
	).not.toThrow();
	// Forty code points, not forty UTF-16 units.
	expect(() =>
		createFolder(layout(), "folder.1", "😀".repeat(FOLDER_NAME_MAX)),
	).not.toThrow();
	expect(problem(() => createFolder(layout(), "folder.1", "a\u0007b"))).toBe(
		"bad-name",
	);
	expect(problem(() => createFolder(made, "folder.2", "WORK"))).toBe(
		"duplicate",
	);
	let full = layout();
	for (let i = 0; i < MAX_FOLDERS; i++)
		full = createFolder(full, `folder.${i}`, `Folder ${i}`);
	expect(problem(() => createFolder(full, "folder.x", "One more"))).toBe(
		"full",
	);
});

test("a rename keeps the folder's place and rooms, refuses another folder's name and accepts its own", () => {
	const two = createFolder(
		createFolder(layout(), "folder.1", "Work"),
		"folder.2",
		"Play",
	);
	const renamed = renameFolder(two, "folder.1", "Office");
	expect(renamed.folders.map((f) => f.name)).toEqual(["Office", "Play"]);
	expect(problem(() => renameFolder(two, "folder.1", "play"))).toBe(
		"duplicate",
	);
	expect(renameFolder(two, "folder.1", "WORK").folders[0]?.name).toBe("WORK");
	expect(problem(() => renameFolder(two, "folder.9", "X"))).toBe("no-folder");
});

test("folders are placed before a neighbour or at the end, and a stale neighbour means the end", () => {
	let state = layout();
	for (const id of ["f1", "f2", "f3"])
		state = createFolder(state, id, id.toUpperCase());
	expect(placeFolder(state, "f3", "f1").folders.map((f) => f.id)).toEqual([
		"f3",
		"f1",
		"f2",
	]);
	expect(placeFolder(state, "f1", null).folders.map((f) => f.id)).toEqual([
		"f2",
		"f3",
		"f1",
	]);
	expect(placeFolder(state, "f1", "f9").folders.map((f) => f.id)).toEqual([
		"f2",
		"f3",
		"f1",
	]);
	expect(problem(() => placeFolder(state, "f9", null))).toBe("no-folder");
});

test("a room goes into a folder before another, moves between folders, and out with null", () => {
	let state = createFolder(createFolder(layout(), "f1", "One"), "f2", "Two");
	state = placeRoom(state, A, "f1", null);
	state = placeRoom(state, B, "f1", null);
	state = placeRoom(state, C, "f1", B);
	expect(state.folders[0]?.rooms).toEqual([A, C, B]);
	state = placeRoom(state, C, "f2", null);
	expect(state.folders.map((f) => f.rooms)).toEqual([[A, B], [C]]);
	// Within its own folder, before a neighbour: a reorder.
	state = placeRoom(state, B, "f1", A);
	expect(state.folders[0]?.rooms).toEqual([B, A]);
	state = placeRoom(state, A, null, null);
	expect(state.folders.map((f) => f.rooms)).toEqual([[B], [C]]);
	expect(problem(() => placeRoom(state, A, "f9", null))).toBe("no-folder");
});

test("pinning takes a room out of its folder, and a move into a folder unpins it", () => {
	let state = placeRoom(createFolder(layout(), "f1", "One"), A, "f1", null);
	state = setPinned(state, A, true, null);
	expect(state).toEqual({
		pins: [A],
		folders: [{ id: "f1", name: "One", rooms: [] }],
	});
	state = setPinned(state, B, true, A);
	expect(state.pins).toEqual([B, A]);
	state = setPinned(state, A, true, B);
	expect(state.pins).toEqual([A, B]);
	state = placeRoom(state, A, "f1", null);
	expect(state.pins).toEqual([B]);
	expect(state.folders[0]?.rooms).toEqual([A]);
	state = setPinned(state, B, false, null);
	expect(state.pins).toEqual([]);
	// Unpinning a room that is not pinned changes nothing.
	expect(setPinned(state, C, false, null)).toEqual(state);
});

test("removing a folder sends its rooms to no folder and leaves the others in order", () => {
	let state = createFolder(createFolder(layout(), "f1", "One"), "f2", "Two");
	state = placeRoom(placeRoom(state, A, "f1", null), B, "f2", null);
	state = setPinned(state, C, true, null);
	const left = removeFolder(state, "f1");
	expect(left).toEqual({
		pins: [C],
		folders: [{ id: "f2", name: "Two", rooms: [B] }],
	});
	expect(problem(() => removeFolder(left, "f1"))).toBe("no-folder");
});

test("shown hides rooms that are gone and keeps their place in the stored layout untouched", () => {
	const state: LayoutView = {
		pins: [A, D],
		folders: [{ id: "f1", name: "One", rooms: [B, "app:agent.deleted", C] }],
	};
	const known = new Set([A, B, C]);
	expect(shown(state, (key) => known.has(key))).toEqual({
		pins: [A],
		folders: [{ id: "f1", name: "One", rooms: [B, C] }],
	});
	expect(state.pins).toEqual([A, D]);
});
