// What a lifted row does, for the rows the room list needs at once. The edits themselves
// (`layout-actions.ts`) load when the first one is made, and the folds (`folds.ts`) when a folder is drawn.

import type { Lifting } from "./row-press.ts";

const actions = () => import("./layout-actions.ts");

/** What a lifted room row does: where it may be dropped, and what a drop does. */
export const roomLifting = (key: string): Lifting => ({
	mode: "room",
	key,
	item: (source) => source.closest<HTMLElement>("[data-drop-item]"),
	root: (source) => source.closest<HTMLElement>("[data-drop-root]"),
	onDrop: (outcome) => {
		if (outcome.type === "room")
			void actions().then((one) => one.dropRoom(key, outcome.drop));
	},
	open: (folder) =>
		void import("./folds.ts").then((one) => one.expandFolder(folder)),
});
