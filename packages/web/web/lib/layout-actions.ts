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
import { arrangementNow, layoutNow } from "./layout.ts";
import { editFor, type RoomDrop } from "./reorder.ts";
import { placeOf } from "./sections.ts";
import { toast } from "./toast.ts";

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
