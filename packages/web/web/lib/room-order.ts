// The order the room list shows its rooms in, as a flat run the keyboard steps through. A pure function
// of the room list, the owners' layout and what the person folded or opened, so a test needs no browser
// and the order holds on a page that draws no list (a phone with a room open).

import { type SectionsInput, sections } from "./sections.ts";

/** One room the list can hold, and whether the list shows it now. */
export interface Stop {
	key: string;
	shown: boolean;
}

export interface OrderOptions {
	/** A room's newest activity, as the list sorts by it. */
	at(key: string): number;
	/** The folders folded on this device. */
	collapsed: ReadonlySet<string>;
	/** The finished threads whose fold is open. */
	expanded: ReadonlySet<string>;
	/** The room open now; its folder and its fold show open, whatever was kept. */
	current: string | undefined;
}

/**
 * Every room of the list in the order it is drawn: Home, the pinned rooms, the folders, the rest (agents
 * then groups while there are no folders), and the threads whose room is gone; a room's threads follow
 * it, the open ones first. `shown` is false for the rooms in a folded folder and the finished threads
 * under a closed fold.
 */
export function roomStops(state: SectionsInput, options: OrderOptions): Stop[] {
	const { collapsed, expanded, current } = options;
	const arrangement = sections(state, options.at);
	const stops: Stop[] = [];
	const room = (key: string, shown: boolean) => {
		stops.push({ key, shown });
		const threads = arrangement.threads[key];
		if (!threads) return;
		for (const open of threads.open) stops.push({ key: open, shown });
		for (const closed of threads.closed)
			stops.push({
				key: closed,
				shown: shown && (expanded.has(closed) || closed === current),
			});
	};
	for (const key of arrangement.home) room(key, true);
	for (const key of arrangement.pinned) room(key, true);
	for (const folder of arrangement.folders) {
		const open =
			!collapsed.has(folder.id) ||
			(current !== undefined && folder.rooms.includes(current));
		for (const key of folder.rooms) room(key, open);
	}
	const rest =
		arrangement.folders.length > 0
			? arrangement.rest
			: [...arrangement.restAgents, ...arrangement.restGroups];
	for (const key of rest) room(key, true);
	const { orphans } = arrangement;
	for (const key of orphans.open) stops.push({ key, shown: true });
	for (const key of orphans.closed)
		stops.push({
			key,
			shown: expanded.has(key) || key === current,
		});
	return stops;
}

/**
 * The room after (`1`) or before (`-1`) `current` among the stops `wanted` accepts, without wrapping.
 * With no current room the run starts from its end. A current room the run does not hold has no neighbour.
 */
export function neighbour(
	stops: readonly Stop[],
	current: string | undefined,
	direction: 1 | -1,
	wanted: (stop: Stop) => boolean,
): string | undefined {
	let at = direction === 1 ? -1 : stops.length;
	if (current !== undefined) {
		at = stops.findIndex((stop) => stop.key === current);
		if (at < 0) return undefined;
	}
	for (let i = at + direction; i >= 0 && i < stops.length; i += direction) {
		const stop = stops[i];
		if (stop && wanted(stop)) return stop.key;
	}
	return undefined;
}
