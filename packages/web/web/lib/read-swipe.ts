// A room's row marks the room read when it is swiped to the right, on the rooms page and in the
// drawer. The swipe is a shortcut for the room menu's "Mark as read"; it loads with the first list.

import { markAllRead } from "./bulk-actions.ts";
import { unreadIn } from "./bulk-items.ts";
import { attachRowSwipe } from "./row-swipe.ts";

/** A room's row: the rooms page's and the drawer's. A thread card nested under a row is not one. */
const ROW = "a.room-row[data-room], a.switcher-row[data-room]";

const keyOf = (row: HTMLElement): string => row.dataset.room ?? "";

/** Whether the room of `row`, or a thread under it, has anything unread. */
const hasUnread = (row: HTMLElement): boolean =>
	Object.keys(unreadIn([keyOf(row)])).length > 0;

/** Gives the room rows inside `root` the swipe that marks them read; returns what takes it off. */
export function attachReadSwipe(root: HTMLElement): () => void {
	const swipe = attachRowSwipe(root, {
		row: ROW,
		can: (row) =>
			hasUnread(row) &&
			row.closest("[data-lifted], [data-reordering]") === null,
		act: (row) => void markAllRead([keyOf(row)]),
		leaves: false,
		reveal: (row) =>
			row.parentElement?.querySelector<HTMLElement>(":scope > .read-reveal") ??
			null,
	});
	return swipe.detach;
}
