// The menu items that arrange the room list: pin, move to a folder, and the steps up and down for a
// room; rename, mute, steps and delete for a folder. Built when a menu opens, from the list as it is then.

import { nudgeBefore } from "../../src/layout-order.ts";
import type { MenuItem } from "./action-menu.ts";
import { store } from "./app-store.ts";
import { bulkItems } from "./bulk-items.ts";
import { chatsHome } from "./home-mode.ts";
import "./layout-icons.ts";
import { askFolderDialog } from "./folder-dialogs.ts";
import { arrangementNow } from "./layout-now.ts";
import type { Leave, MenuSpec } from "./menu-items.ts";
import { translate as t } from "./messages.ts";
import { muteState, placeOf } from "./sections.ts";

const now: Leave = (go) => go();

/** The edits load when the first is made, not when a menu opens. */
const edit = (): Promise<typeof import("./layout-actions.ts")> =>
	import("./layout-actions.ts");

/** Pin or unpin, move to a folder, and a step up or down within the room's list; Home takes the pin and its steps only. */
export function placementItems(key: string, leave: Leave = now): MenuItem[] {
	const place = placeOf(arrangementNow(), key);
	const pinned = place.kind === "pinned";
	const home = store.getState().rooms[key]?.view?.home === true;
	// A hidden room is in none of the home's lists, so its place is not shown; showing it again is its one step.
	if (!home && chatsHome() && store.getState().hidden.includes(key))
		return [
			{
				id: "unhide",
				label: t("Unhide"),
				icon: "eye",
				run: () => {
					void edit().then((one) => one.hideRoom(key, false));
				},
			},
		];
	const items: MenuItem[] = [
		{
			id: "pin",
			label: pinned ? t("Unpin") : t("Pin"),
			icon: "pin",
			run: () => {
				void edit().then((one) => one.pinRoom(key, !pinned));
			},
		},
	];
	if (!home)
		items.push({
			id: "move",
			label: t("Move to folder…"),
			icon: "folder",
			run: () => leave(() => askFolderDialog({ kind: "move", room: key })),
		});
	// The chat list takes a room off the home without touching its pin or folder.
	if (!home && chatsHome())
		items.push({
			id: "hide",
			label: t("Hide"),
			icon: "eye-off",
			run: () => {
				void edit().then((one) => one.hideRoom(key, true));
			},
		});
	if (place.kind === "rest") return items;
	if (nudgeBefore(place.siblings, key, "up"))
		items.push({
			id: "up",
			label: t("Move up"),
			icon: "up",
			run: () => {
				void edit().then((one) => one.nudgeRoom(key, "up"));
			},
		});
	if (nudgeBefore(place.siblings, key, "down"))
		items.push({
			id: "down",
			label: t("Move down"),
			icon: "down",
			run: () => {
				void edit().then((one) => one.nudgeRoom(key, "down"));
			},
		});
	return items;
}

/** The actions of a folder's header. */
export function folderMenu(id: string): MenuSpec | undefined {
	const state = store.getState();
	const folder = state.folders.find((one) => one.id === id);
	if (!folder) return undefined;
	const shown =
		arrangementNow().folders.find((one) => one.id === id)?.rooms ?? [];
	const allMuted =
		muteState(shown, (room) => state.rooms[room]?.view?.muted === true) ===
		"all";
	const order = state.folders.map((one) => one.id);
	const items: MenuItem[] = [
		{
			id: "rename",
			label: t("Rename"),
			icon: "edit",
			run: () => askFolderDialog({ kind: "rename", id, name: folder.name }),
		},
	];
	if (shown.length > 0)
		items.push({
			id: "mute",
			label: allMuted
				? t("Unmute the whole folder")
				: t("Mute the whole folder"),
			icon: allMuted ? "bell" : "bell-off",
			run: () => {
				void edit().then((one) => one.muteFolder(id, !allMuted));
			},
		});
	items.push(...bulkItems(shown));
	if (nudgeBefore(order, id, "up"))
		items.push({
			id: "up",
			label: t("Move up"),
			icon: "up",
			run: () => {
				void edit().then((one) => one.nudgeFolder(id, "up"));
			},
		});
	if (nudgeBefore(order, id, "down"))
		items.push({
			id: "down",
			label: t("Move down"),
			icon: "down",
			run: () => {
				void edit().then((one) => one.nudgeFolder(id, "down"));
			},
		});
	items.push({
		id: "delete",
		label: t("Delete folder"),
		icon: "trash",
		tone: "danger",
		run: () => askFolderDialog({ kind: "delete", id, name: folder.name }),
	});
	return { title: folder.name, items };
}
