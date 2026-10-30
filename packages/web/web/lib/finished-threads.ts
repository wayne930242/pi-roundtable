// Which dispatch threads the room list shows under which rooms, for the actions that act on many
// rooms at once (clear every finished thread, mark everything read).

import { store } from "./app-store.ts";

/** The listed threads that hang under a listed room, by that room; with `parents`, only those rooms'. */
function threadsByRoom(
	parents: ReadonlySet<string> | undefined,
	wanted: (closed: boolean) => boolean,
): Map<string, string[]> {
	const state = store.getState();
	const byRoom = new Map<string, string[]>();
	for (const key of state.order) {
		const view = state.rooms[key]?.view;
		if (view?.kind !== "thread" || !view.parent) continue;
		if (parents && !parents.has(view.parent)) continue;
		const parent = state.rooms[view.parent]?.view;
		if (!parent || parent.kind === "thread") continue;
		if (!wanted(view.closed === true)) continue;
		byRoom.set(view.parent, [...(byRoom.get(view.parent) ?? []), key]);
	}
	return byRoom;
}

/** The finished threads under the rooms, by room; every listed room's when none are named. */
export const finishedUnder = (
	parents?: readonly string[],
): Map<string, string[]> =>
	threadsByRoom(parents && new Set(parents), (closed) => closed);

/** Every listed thread, open or finished, under the named rooms. */
export const threadsUnder = (parents: readonly string[]): string[] =>
	[...threadsByRoom(new Set(parents), () => true).values()].flat();

/**
 * The names of the finished temp knights the list shows under each room, by that room; with
 * `parents`, only those rooms'. A temp knight whose room the list does not hold is left out.
 */
export function finishedHelpersUnder(
	parents?: readonly string[],
): Map<string, string[]> {
	const state = store.getState();
	const wanted = parents && new Set(parents);
	const byRoom = new Map<string, string[]>();
	for (const key of state.order) {
		const view = state.rooms[key]?.view;
		const parent = view?.helper?.parent;
		if (!view || !parent || view.helper?.finished !== true) continue;
		if (wanted && !wanted.has(parent)) continue;
		if (!state.rooms[parent]?.view) continue;
		byRoom.set(parent, [...(byRoom.get(parent) ?? []), view.name]);
	}
	return byRoom;
}
