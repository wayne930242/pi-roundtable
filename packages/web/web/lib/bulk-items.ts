// The two menu items that act on many rooms at once, for the room list's menu (every room) and a
// folder's (its rooms): mark everything read, and clear every finished thread. Each is left out
// when it would do nothing, and does its work in `bulk-actions.ts`, loaded when it is chosen.

import type { MenuItem } from "./action-menu.ts";
import {
	finishedHelpersUnder,
	finishedUnder,
	threadsUnder,
} from "./finished-threads.ts";
import { unreadCounts } from "./host-state.ts";
import "./layout-icons.ts";
import { translate as t } from "./messages.ts";

/** The unread count of each room in `rooms` and of the threads under them; of every room when none are named. */
export function unreadIn(rooms?: readonly string[]): Record<string, number> {
	const counts = unreadCounts();
	if (!rooms) return counts;
	const scope = new Set([...rooms, ...threadsUnder(rooms)]);
	return Object.fromEntries(
		Object.entries(counts).filter(([key]) => scope.has(key)),
	);
}

const actions = () => import("./bulk-actions.ts");

/** The items for `rooms` (a folder's), or for every room of the list when none are named. */
export function bulkItems(rooms?: readonly string[]): MenuItem[] {
	const items: MenuItem[] = [];
	if (Object.keys(unreadIn(rooms)).length > 0)
		items.push({
			id: "read-all",
			label: t("Mark all as read"),
			icon: "check",
			run: () => {
				void actions().then((one) => one.markAllRead(rooms));
			},
		});
	if (finishedUnder(rooms).size > 0)
		items.push({
			id: "clear-finished",
			label: t("Clear all finished threads"),
			icon: "trash",
			tone: "danger",
			run: () => {
				void actions().then((one) => one.clearAllFinished(rooms));
			},
		});
	items.push(...helperItems(rooms));
	return items;
}

/** "Clear finished temp knights" for `rooms` (a folder's or one knight's), or for every knight; left out when none has finished. */
export function helperItems(rooms?: readonly string[]): MenuItem[] {
	if (finishedHelpersUnder(rooms).size === 0) return [];
	return [
		{
			id: "clear-helpers",
			label: t("Clear finished temp knights"),
			icon: "trash",
			tone: "danger",
			run: () => {
				void actions().then((one) => one.clearFinishedHelpers(rooms));
			},
		},
	];
}
