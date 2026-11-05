// A room's row on the rooms page turns its modes when it is swiped to the left: none, then yolo, then
// yolo with long-running, then none again. The swipe is a shortcut for the room menu's mode items, so
// it asks nothing; its notice's Undo is the way back. It loads with the first list.

import type { RoomMode } from "../../src/api-types.ts";
import { api, messageOf } from "./api.ts";
import { store } from "./app-store.ts";
import { translate as t } from "./messages.ts";
import { modeReveal } from "./mode-reveal.tsx";
import { attachRowSwipe } from "./row-swipe.ts";
import { toast } from "./toast.ts";

type Modes = Pick<RoomMode, "yolo" | "longRunning">;

/** A room's row on the rooms page; not a temp knight's, not a thread card, not the drawer's. */
const ROW = "a.room-row[data-room]";

const keyOf = (row: HTMLElement): string => row.dataset.room ?? "";

/** The modes a swipe turns `now` to. */
export function nextModes(now: Modes): Modes {
	if (now.yolo && !now.longRunning) return { yolo: true, longRunning: true };
	if (now.yolo || now.longRunning) return { yolo: false, longRunning: false };
	return { yolo: true, longRunning: false };
}

/** The modes the room has to switch, or none when its modes are not its own to switch. */
function modesOf(key: string): Modes | undefined {
	const room = store.getState().rooms[key];
	if (!room?.view || room.view.readOnly || room.mode.inheritedFrom)
		return undefined;
	return { yolo: room.mode.yolo, longRunning: room.mode.longRunning };
}

const show = (room: string, modes: Modes) =>
	store.dispatch({ type: "mode", room, ...modes });

/** Shows `to` on the room at once and asks the server; a refusal puts `from` back. */
async function setModes(
	room: string,
	from: Modes,
	to: Modes,
): Promise<boolean> {
	show(room, to);
	try {
		const { mode } = await api.setMode(room, to);
		show(room, mode);
		return true;
	} catch (failure) {
		show(room, from);
		toast(messageOf(failure), "danger");
		return false;
	}
}

function said(name: string, modes: Modes): string {
	if (modes.yolo && modes.longRunning)
		return t("{name}: Yolo and long-running on", { name });
	if (modes.yolo) return t("{name}: Yolo on", { name });
	return t("{name}: modes off", { name });
}

async function cycle(room: string): Promise<void> {
	const from = modesOf(room);
	if (!from) return;
	const to = nextModes(from);
	if (!(await setModes(room, from, to))) return;
	const name = store.getState().rooms[room]?.view?.displayName ?? room;
	toast(said(name, to), "info", {
		label: t("Undo"),
		run: () => void setModes(room, to, from),
	});
}

/** Gives the room rows inside `root` the swipe that turns their modes; returns what takes it off. */
export function attachModeSwipe(root: HTMLElement): () => void {
	const swipe = attachRowSwipe(root, {
		direction: "left",
		row: ROW,
		can: (row) =>
			modesOf(keyOf(row)) !== undefined &&
			row.closest("[data-lifted], [data-reordering], [data-arranging]") ===
				null,
		act: (row) => void cycle(keyOf(row)),
		leaves: false,
		reveal: (row) => {
			const now = modesOf(keyOf(row));
			return now ? modeReveal(row, nextModes(now)) : null;
		},
	});
	return swipe.detach;
}
