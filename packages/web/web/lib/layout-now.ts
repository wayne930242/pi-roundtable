// The layout and arrangement the page holds now, for the edits and menus that load on demand.

import type { LayoutView } from "../../src/api-types.ts";
import { store } from "./app-store.ts";
import { lastMessage, type RoomsState } from "./rooms.ts";
import { type Sections, sections } from "./sections.ts";

/** When the room last said something, in epoch ms; a number below any real one for a room that has not. */
export function activityAt(state: RoomsState, room: string): number {
	const at = Date.parse(lastMessage(state, room)?.at ?? "");
	return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}

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
