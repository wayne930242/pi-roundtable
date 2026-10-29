// The owners' arrangement of the room list, from the page: each edit is applied at once, sent to the
// server, and replaced by the server's answer; a refusal puts the list back and says why. The same
// pure functions the server applies (`src/layout-order.ts`) make the optimistic step.

import type { LayoutView } from "../../src/api-types.ts";
import {
	nudgeBefore,
	placeFolder,
	placeRoom,
	removeFolder,
	renameFolder,
	setPinned,
} from "../../src/layout-order.ts";
import { api, messageOf } from "./api.ts";
import { store } from "./app-store.ts";
import { editFor, type RoomDrop } from "./reorder.ts";
import { activityAt } from "./rooms.ts";
import type { Lifting } from "./row-press.ts";
import { placeOf, type Sections, sections } from "./sections.ts";
import { signal } from "./signal.ts";
import { toast } from "./toast.ts";

/** The layout the page holds now. */
export const layoutNow = (): LayoutView => {
	const { pins, folders } = store.getState();
	return { pins, folders };
};

/** The arrangement of the list as the page shows it now. */
export function arrangementNow(): Sections {
	const state = store.getState();
	return sections(state, (key) => activityAt(state, key));
}

/** Where a refusal is said: a notice by default, or the dialog that asked, which a notice would hide behind. */
export type Fail = (message: string) => void;
const shout: Fail = (message) => toast(message, "danger");

const hold = (layout: LayoutView) =>
	store.dispatch({
		type: "layout_loaded",
		pins: layout.pins,
		folders: layout.folders,
	});

/**
 * Shows `guess` (when it can be made) at once, then takes the server's answer. A refusal restores what
 * the page held, asks for the list again, and shows the server's words. Resolves to the stored layout,
 * or undefined when the edit was refused.
 */
async function apply(
	guess: (layout: LayoutView) => LayoutView,
	send: () => Promise<LayoutView>,
	fail: Fail = shout,
): Promise<LayoutView | undefined> {
	const before = layoutNow();
	try {
		hold(guess(before));
	} catch {
		// The server judges an edit the page cannot (a name taken meanwhile); its words are the answer.
	}
	try {
		const answer = await send();
		hold(answer);
		return answer;
	} catch (failure) {
		hold(before);
		store.dispatch({ type: "changed" });
		fail(messageOf(failure));
		return undefined;
	}
}

/** Pins a room last among the pinned, or unpins it; a pinned room leaves its folder. */
export const pinRoom = (
	room: string,
	pinned: boolean,
	before: string | null = null,
) =>
	apply(
		(layout) => setPinned(layout, room, pinned, before),
		() => api.pinRoom(room, pinned, before),
	);

/** Puts a room in a folder before another room of it (`null` = last), or in none. */
export const moveRoom = (
	room: string,
	folder: string | null,
	before: string | null = null,
) =>
	apply(
		(layout) => placeRoom(layout, room, folder, before),
		() => api.placeRoom(room, folder, before),
	);

/** Moves a pinned room or a room of a folder one step; nothing when it is at that end or in neither. */
export function nudgeRoom(room: string, direction: "up" | "down") {
	const place = placeOf(arrangementNow(), room);
	if (place.kind === "rest") return undefined;
	const step = nudgeBefore(place.siblings, room, direction);
	if (!step) return undefined;
	return place.kind === "pinned"
		? pinRoom(room, true, step.before)
		: moveRoom(room, place.folder, step.before);
}

/** Makes a folder and resolves to its id; undefined when it was refused. */
export async function createFolder(
	name: string,
	fail: Fail = shout,
): Promise<string | undefined> {
	try {
		const answer = await api.createFolder(name);
		hold(answer);
		// A new folder is last.
		return answer.folders.at(-1)?.id;
	} catch (failure) {
		fail(messageOf(failure));
		return undefined;
	}
}

export const renameFolderTo = (id: string, name: string, fail?: Fail) =>
	apply(
		(layout) => renameFolder(layout, id, name),
		() => api.changeFolder(id, { name }),
		fail,
	);

/** Places a folder before another (`null` = last). */
export const placeFolderBefore = (id: string, before: string | null) =>
	apply(
		(layout) => placeFolder(layout, id, before),
		() => api.changeFolder(id, { before }),
	);

/** Moves a folder one step. */
export function nudgeFolder(id: string, direction: "up" | "down") {
	const step = nudgeBefore(
		layoutNow().folders.map((folder) => folder.id),
		id,
		direction,
	);
	return step ? placeFolderBefore(id, step.before) : undefined;
}

/** Deletes a folder; its rooms are in no folder. */
export const deleteFolder = (id: string, fail?: Fail) =>
	apply(
		(layout) => removeFolder(layout, id),
		() => api.deleteFolder(id),
		fail,
	);

/** Mutes or unmutes every room of a folder, and shows the bells at once. */
export async function muteFolder(id: string, muted: boolean): Promise<boolean> {
	try {
		const answer = await api.muteFolder(id, muted);
		for (const room of answer.rooms)
			store.dispatch({ type: "room_muted", room, muted: answer.muted });
		return true;
	} catch (failure) {
		shout(messageOf(failure));
		return false;
	}
}

// ── A drop ───────────────────────────────────────────────────────────────────────────────────

/** Applies where a dragged room was dropped; nothing when it would end up as it was. */
export function dropRoom(room: string, drop: RoomDrop) {
	const edit = editFor(placeOf(arrangementNow(), room), room, drop);
	if (!edit) return undefined;
	if (edit.kind === "pin") return pinRoom(room, true, edit.before);
	if (edit.kind === "folder") return moveRoom(room, edit.folder, edit.before);
	return moveRoom(room, null);
}

/** What a lifted room row or folder block does: where it may be dropped, and what a drop does. */
export const roomLifting = (key: string): Lifting => ({
	mode: "room",
	key,
	item: (source) => source.closest<HTMLElement>("[data-drop-item]"),
	root: (source) => source.closest<HTMLElement>("[data-drop-root]"),
	onDrop: (outcome) => {
		if (outcome.type === "room") void dropRoom(key, outcome.drop);
	},
	open: expandFolder,
});

export const folderLifting = (id: string): Lifting => ({
	mode: "folder",
	key: id,
	item: (source) => source.closest<HTMLElement>("[data-folder-block]"),
	root: (source) =>
		source.closest<HTMLElement>("[data-folder-block]")?.parentElement ?? null,
	onDrop: (outcome) => {
		if (outcome.type === "folder") void placeFolderBefore(id, outcome.before);
	},
	open: expandFolder,
});

// ── Collapsed folders: per device ────────────────────────────────────────────────────────────

export const COLLAPSED_KEY = "roundtable-console:folders-collapsed";

function loadCollapsed(): ReadonlySet<string> {
	try {
		const raw = localStorage.getItem(COLLAPSED_KEY);
		const value: unknown = raw ? JSON.parse(raw) : [];
		return new Set(
			Array.isArray(value)
				? value.filter((one): one is string => typeof one === "string")
				: [],
		);
	} catch {
		return new Set();
	}
}

let collapsed: ReadonlySet<string> | undefined;
const { emit, use } = signal();

const held = (): ReadonlySet<string> => {
	collapsed ??= loadCollapsed();
	return collapsed;
};

function keep(next: ReadonlySet<string>): void {
	collapsed = next;
	try {
		localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
	} catch {
		// A browser that refuses storage keeps the folds for this page only.
	}
	emit();
}

/** The folders folded on this device. A device starts with every folder open. */
export const useCollapsed = (): ReadonlySet<string> => use(held);

export function toggleCollapsed(id: string): void {
	const next = new Set(held());
	if (!next.delete(id)) next.add(id);
	keep(next);
}

/** Opens a folded folder on this device. */
export function expandFolder(id: string): void {
	if (!held().has(id)) return;
	const next = new Set(held());
	next.delete(id);
	keep(next);
}

/** Forgets the folded folders that no longer exist, once the list is known. */
export function pruneCollapsed(existing: readonly string[]): void {
	const live = new Set(existing);
	const now = held();
	if ([...now].every((id) => live.has(id))) return;
	keep(new Set([...now].filter((id) => live.has(id))));
}

/** Re-reads the folds from storage; for a test that changes it. */
export function reloadCollapsed(): void {
	collapsed = undefined;
	emit();
}
