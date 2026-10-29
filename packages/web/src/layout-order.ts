// The arrangement of the room list as plain functions over `LayoutView`. The server applies them to
// the stored layout under a lock and the page applies the same ones at once (optimistic), so a move
// means the same on both sides. Nothing here touches a database or the DOM.

import type { FolderView, LayoutView } from "./api-types.ts";

/** The most folders there can be. */
export const MAX_FOLDERS = 50;
/** The most code points of a folder's name. */
export const FOLDER_NAME_MAX = 40;

export const EMPTY_LAYOUT: LayoutView = { pins: [], folders: [] };

/** Why an edit of the layout was refused. */
export type LayoutProblem = "bad-name" | "no-folder" | "duplicate" | "full";

export class LayoutError extends Error {
	constructor(readonly code: LayoutProblem) {
		super(code);
		this.name = "LayoutError";
	}
}

/**
 * `list` with `item` standing before `before`, or last when `before` is none or not in the list (a
 * neighbour that was deleted meanwhile). `item` is taken out of its old place first; before itself
 * it stays where it is.
 */
export function moveBefore<T>(
	list: readonly T[],
	item: T,
	before: T | null | undefined,
): T[] {
	if (before === item && list.includes(item)) return [...list];
	const rest = list.filter((one) => one !== item);
	const at =
		before === null || before === undefined ? -1 : rest.indexOf(before);
	if (at < 0) return [...rest, item];
	return [...rest.slice(0, at), item, ...rest.slice(at)];
}

/**
 * Where moving `item` one step goes in the list as it is shown: the neighbour it then stands
 * before (`null` = last). Undefined when it is not in the list or already at that end. Reading the
 * neighbour from what is shown keeps a step right when the stored list holds rooms that are hidden.
 */
export function nudgeBefore(
	shownList: readonly string[],
	item: string,
	direction: "up" | "down",
): { before: string | null } | undefined {
	const at = shownList.indexOf(item);
	if (at < 0) return undefined;
	if (direction === "up")
		return at === 0 ? undefined : { before: shownList[at - 1] ?? null };
	return at === shownList.length - 1
		? undefined
		: { before: shownList[at + 2] ?? null };
}

/** A folder's name as stored: trimmed, 1 to 40 code points, without control characters. */
export function folderNameOf(raw: string): string {
	const name = raw.trim();
	const length = Array.from(name).length;
	if (length < 1 || length > FOLDER_NAME_MAX || /\p{Cc}/u.test(name))
		throw new LayoutError("bad-name");
	return name;
}

const same = (a: string, b: string): boolean =>
	a.toLocaleLowerCase() === b.toLocaleLowerCase();

function folderIndex(layout: LayoutView, id: string): number {
	const at = layout.folders.findIndex((folder) => folder.id === id);
	if (at < 0) throw new LayoutError("no-folder");
	return at;
}

const withFolders = (
	layout: LayoutView,
	folders: FolderView[],
): LayoutView => ({ pins: layout.pins, folders });

/** The layout with a new last folder. */
export function createFolder(
	layout: LayoutView,
	id: string,
	rawName: string,
): LayoutView {
	const name = folderNameOf(rawName);
	if (layout.folders.some((folder) => same(folder.name, name)))
		throw new LayoutError("duplicate");
	if (layout.folders.length >= MAX_FOLDERS) throw new LayoutError("full");
	return withFolders(layout, [...layout.folders, { id, name, rooms: [] }]);
}

export function renameFolder(
	layout: LayoutView,
	id: string,
	rawName: string,
): LayoutView {
	const at = folderIndex(layout, id);
	const name = folderNameOf(rawName);
	if (layout.folders.some((f) => f.id !== id && same(f.name, name)))
		throw new LayoutError("duplicate");
	return withFolders(
		layout,
		layout.folders.map((folder, i) =>
			i === at ? { ...folder, name } : folder,
		),
	);
}

/** The folder moved before another, or last. */
export function placeFolder(
	layout: LayoutView,
	id: string,
	before: string | null,
): LayoutView {
	const at = folderIndex(layout, id);
	const moving = layout.folders[at] as FolderView;
	const ids = moveBefore(
		layout.folders.map((folder) => folder.id),
		id,
		before,
	);
	return withFolders(
		layout,
		ids.map((one) =>
			one === id
				? moving
				: (layout.folders.find((folder) => folder.id === one) as FolderView),
		),
	);
}

/** The layout without the folder; its rooms are in no folder. */
export function removeFolder(layout: LayoutView, id: string): LayoutView {
	folderIndex(layout, id);
	return withFolders(
		layout,
		layout.folders.filter((folder) => folder.id !== id),
	);
}

/** The layout without a room: not pinned and in no folder. For a room that is gone for good. */
export const forgetRoom = (layout: LayoutView, room: string): LayoutView => ({
	pins: layout.pins.filter((one) => one !== room),
	folders: layout.folders.map((folder) =>
		folder.rooms.includes(room)
			? { ...folder, rooms: folder.rooms.filter((one) => one !== room) }
			: folder,
	),
});

/**
 * A room into a folder before another room of it (or last), or into none with `folder` null. A
 * room is in one place, so it leaves its pin and its old folder.
 */
export function placeRoom(
	layout: LayoutView,
	room: string,
	folder: string | null,
	before: string | null,
): LayoutView {
	if (folder !== null) folderIndex(layout, folder);
	const clear = forgetRoom(layout, room);
	if (folder === null) return clear;
	return withFolders(
		clear,
		clear.folders.map((one) =>
			one.id === folder
				? { ...one, rooms: moveBefore(one.rooms, room, before) }
				: one,
		),
	);
}

/** A room pinned before another pinned room (or last), or unpinned. A pinned room leaves its folder. */
export function setPinned(
	layout: LayoutView,
	room: string,
	pinned: boolean,
	before: string | null,
): LayoutView {
	const clear = forgetRoom(layout, room);
	if (!pinned) return clear;
	return {
		pins: moveBefore(
			layout.pins.filter((one) => one !== room),
			room,
			before,
		),
		folders: clear.folders,
	};
}

/** The layout with only the rooms `known` accepts, for a reader who must not see a deleted agent's room. */
export function shown(
	layout: LayoutView,
	known: (room: string) => boolean,
): LayoutView {
	return {
		pins: layout.pins.filter(known),
		folders: layout.folders.map((folder) => ({
			...folder,
			rooms: folder.rooms.filter(known),
		})),
	};
}
