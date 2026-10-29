import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { LayoutView, RoomView } from "../src/api-types.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import {
	COLLAPSED_KEY,
	layoutNow,
	pruneCollapsed,
	reloadCollapsed,
	toggleCollapsed,
} from "./lib/layout.ts";
import {
	createFolder,
	deleteFolder,
	moveRoom,
	nudgeFolder,
	nudgeRoom,
	pinRoom,
	renameFolderTo,
} from "./lib/layout-actions.ts";
import { initialState, reduce } from "./lib/rooms.ts";

const A = "app:agent.a";
const B = "app:agent.b";
const C = "app:agent.c";
const HIDDEN = "app:agent.hidden";

const view = (key: string): RoomView => ({
	key,
	kind: "agent",
	name: key.slice(key.indexOf(".") + 1),
	displayName: key.slice(key.indexOf(".") + 1),
	home: false,
	readOnly: false,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
});

const load = (layout: Partial<LayoutView> = {}) =>
	store.dispatch({
		type: "rooms_loaded",
		rooms: [view(A), view(B), view(C)],
		pins: layout.pins ?? [],
		folders: layout.folders ?? [],
	});

const storage = new Map<string, string>();
beforeEach(() => {
	storage.clear();
	Object.defineProperty(globalThis, "localStorage", {
		value: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => void storage.set(key, value),
			removeItem: (key: string) => void storage.delete(key),
		},
		configurable: true,
	});
	reloadCollapsed();
	load();
});
afterEach(() => {
	store.dispatch({ type: "rooms_loaded", rooms: [], pins: [], folders: [] });
});

test("the room list carries the shared layout, and a layout answer replaces it", () => {
	const state = reduce(initialState(), {
		type: "rooms_loaded",
		rooms: [view(A)],
		pins: [A],
		folders: [{ id: "f1", name: "One", rooms: [] }],
	});
	expect(state.pins).toEqual([A]);
	expect(state.folders).toEqual([{ id: "f1", name: "One", rooms: [] }]);
	// A list without a layout keeps the one held.
	expect(
		reduce(state, { type: "rooms_loaded", rooms: [view(A)] }).pins,
	).toEqual([A]);
	const answered = reduce(state, {
		type: "layout_loaded",
		pins: [],
		folders: [],
	});
	expect([answered.pins, answered.folders]).toEqual([[], []]);
});

test("a move shows at once and then takes the server's answer", async () => {
	load({ folders: [{ id: "f1", name: "One", rooms: [] }] });
	let release: (layout: LayoutView) => void = () => undefined;
	const place = spyOn(api, "placeRoom").mockImplementation(
		() => new Promise((resolve) => (release = resolve)),
	);
	try {
		const done = moveRoom(A, "f1", null);
		expect(place).toHaveBeenCalledWith(A, "f1", null);
		// Before the server has answered, the page already shows the room in the folder.
		expect(layoutNow().folders[0]?.rooms).toEqual([A]);
		release({
			pins: [],
			folders: [{ id: "f1", name: "One", rooms: [A, HIDDEN] }],
		});
		await done;
		expect(layoutNow().folders[0]?.rooms).toEqual([A, HIDDEN]);
	} finally {
		place.mockRestore();
	}
});

test("a move the server refuses is put back, the list is fetched again and the words are shown", async () => {
	load({ pins: [A], folders: [{ id: "f1", name: "One", rooms: [] }] });
	const revision = store.getState().revision;
	const place = spyOn(api, "placeRoom").mockRejectedValue(
		new Error("There is no such folder."),
	);
	try {
		expect(await moveRoom(A, "f1", null)).toBeUndefined();
		expect(layoutNow()).toEqual({
			pins: [A],
			folders: [{ id: "f1", name: "One", rooms: [] }],
		});
		expect(store.getState().revision).toBe(revision + 1);
	} finally {
		place.mockRestore();
	}
});

test("pin, rename, delete and folder moves go through the API and show the answer", async () => {
	load({
		folders: [
			{ id: "f1", name: "One", rooms: [A] },
			{ id: "f2", name: "Two", rooms: [] },
		],
	});
	const pin = spyOn(api, "pinRoom").mockResolvedValue({
		pins: [A],
		folders: [
			{ id: "f1", name: "One", rooms: [] },
			{ id: "f2", name: "Two", rooms: [] },
		],
	});
	const change = spyOn(api, "changeFolder").mockImplementation(
		async (_id, patch) => ({
			pins: [A],
			folders: [
				{ id: "f2", name: "Two", rooms: [] },
				{ id: "f1", name: patch.name ?? "One", rooms: [] },
			],
		}),
	);
	const remove = spyOn(api, "deleteFolder").mockResolvedValue({
		pins: [A],
		folders: [{ id: "f2", name: "Two", rooms: [] }],
	});
	try {
		await pinRoom(A, true);
		expect(pin).toHaveBeenCalledWith(A, true, null);
		expect(layoutNow().pins).toEqual([A]);
		await nudgeFolder("f1", "down");
		expect(change).toHaveBeenLastCalledWith("f1", { before: null });
		expect(layoutNow().folders.map((f) => f.id)).toEqual(["f2", "f1"]);
		await renameFolderTo("f1", "Uno");
		expect(change).toHaveBeenLastCalledWith("f1", { name: "Uno" });
		await deleteFolder("f1");
		expect(layoutNow().folders.map((f) => f.id)).toEqual(["f2"]);
	} finally {
		pin.mockRestore();
		change.mockRestore();
		remove.mockRestore();
	}
});

test("creating a folder resolves to the new folder's id, the last one", async () => {
	const create = spyOn(api, "createFolder").mockResolvedValue({
		pins: [],
		folders: [
			{ id: "f1", name: "One", rooms: [] },
			{ id: "f9", name: "New", rooms: [] },
		],
	});
	try {
		expect(await createFolder("New")).toBe("f9");
		expect(create).toHaveBeenCalledWith("New");
		create.mockRejectedValue(new Error("A folder of that name exists."));
		expect(await createFolder("New")).toBeUndefined();
	} finally {
		create.mockRestore();
	}
});

test("up and down send the neighbour as seen, skipping a room the list does not show", async () => {
	load({
		pins: [A, HIDDEN, B, C],
	});
	// The server's answer is taken as it is, so a step shows no change here.
	const pin = spyOn(api, "pinRoom").mockImplementation(async () => layoutNow());
	try {
		// B is below the hidden room; one step up goes before A, the room that is shown above it.
		await nudgeRoom(B, "up");
		expect(pin).toHaveBeenLastCalledWith(B, true, A);
		load({ pins: [A, HIDDEN, B, C] });
		await nudgeRoom(A, "down");
		expect(pin).toHaveBeenLastCalledWith(A, true, C);
		pin.mockClear();
		// The first pinned room cannot go up; a room in no place has no step.
		load({ pins: [A, B] });
		expect(nudgeRoom(A, "up")).toBeUndefined();
		expect(nudgeRoom(C, "down")).toBeUndefined();
		expect(pin).not.toHaveBeenCalled();
	} finally {
		pin.mockRestore();
	}
});

test("a folded folder is kept per device, and the ones that no longer exist are forgotten", () => {
	toggleCollapsed("f1");
	toggleCollapsed("f2");
	expect(JSON.parse(storage.get(COLLAPSED_KEY) ?? "[]")).toEqual(["f1", "f2"]);
	toggleCollapsed("f2");
	expect(JSON.parse(storage.get(COLLAPSED_KEY) ?? "[]")).toEqual(["f1"]);
	toggleCollapsed("f3");
	pruneCollapsed(["f3"]);
	expect(JSON.parse(storage.get(COLLAPSED_KEY) ?? "[]")).toEqual(["f3"]);
	// Another page of the device reads what this one kept.
	reloadCollapsed();
	toggleCollapsed("f3");
	expect(JSON.parse(storage.get(COLLAPSED_KEY) ?? "[]")).toEqual([]);
});
