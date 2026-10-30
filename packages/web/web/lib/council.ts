import { useSyncExternalStore } from "react";
import type { RoomView } from "../../src/api-types.ts";
import { MAX_SEATED } from "../table/camera.ts";
import { useSelector } from "./app-store.ts";

// The round table is a council: one agent group, shown with its members. There is no store of its
// own, so the groups of the room list are the councils, and the only thing the page keeps is which
// one this device looked at last, in the browser's storage where there is some and for the page's
// life where there is not.

/** The most members a council holds; a group has no more. */
export const COUNCIL_MAX = MAX_SEATED;
/** The fewest members a group holds. */
export const COUNCIL_MIN = 2;

const KEY = "rt-table-council";
let kept: string | undefined;
let read = false;
const listeners = new Set<() => void>();

function stored(): string | undefined {
	try {
		return globalThis.localStorage?.getItem(KEY) ?? undefined;
	} catch {
		return undefined;
	}
}

/** The key of the room of the council this device chose last; undefined when none was. */
export function chosenCouncil(): string | undefined {
	if (!read) {
		kept = stored();
		read = true;
	}
	return kept;
}

export function chooseCouncil(room: string): void {
	kept = room;
	read = true;
	try {
		globalThis.localStorage?.setItem(KEY, room);
	} catch {
		// a browser that refuses storage keeps the choice for the page's life
	}
	for (const listener of listeners) listener();
}

/** Forgets what the page holds in memory (the storage stays); for tests. */
export function resetCouncilChoice(): void {
	kept = undefined;
	read = false;
	for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

/** The room key this device chose last, as the page follows it. */
export const useChosenCouncil = (): string | undefined =>
	useSyncExternalStore(subscribe, chosenCouncil, () => undefined);

/** The groups of the room list, in its order: the councils there are. */
export function useCouncils(): RoomView[] {
	return useSelector(
		(state) =>
			state.order
				.map((key) => state.rooms[key]?.view)
				.filter(
					(view): view is RoomView =>
						view !== undefined && view.kind === "group",
				),
		"councils",
	);
}

/**
 * The council the table shows: the one the address names (its group name or the key of its room),
 * else the one this device chose last, else the first. Undefined when there is no group at all.
 */
export function councilOf(
	councils: readonly RoomView[],
	wanted: string | undefined,
	named?: string,
): RoomView | undefined {
	const find = (one: string | undefined) =>
		one === undefined
			? undefined
			: councils.find((view) => view.key === one || view.name === one);
	return find(named) ?? find(wanted) ?? councils[0];
}

/** The agents a ticked list starts from when there is no council yet: the unmuted ones, the coordinator first, at most a table's worth. */
export function startingTicks(agents: readonly RoomView[]): string[] {
	return [...agents]
		.filter((view) => view.muted !== true && !view.helper)
		.sort((a, b) => Number(b.home) - Number(a.home))
		.slice(0, COUNCIL_MAX)
		.map((view) => view.name);
}

/** A tick turned on or off: the list in the order it was ticked, never past the table's seats. */
export function toggled(
	ticked: readonly string[],
	name: string,
	max = COUNCIL_MAX,
): string[] {
	if (ticked.includes(name)) return ticked.filter((one) => one !== name);
	return ticked.length >= max ? [...ticked] : [...ticked, name];
}

/** The ticks as a group's members: the agents that still exist, in the order ticked, at most a table's worth. */
export function membersOf(
	ticked: readonly string[],
	exists: (name: string) => boolean,
): string[] {
	return ticked.filter(exists).slice(0, COUNCIL_MAX);
}

/** The host of a council: the one it had if that member is still ticked, else the coordinator if ticked, else the first. */
export function hostOf(
	ticked: readonly string[],
	current: string | undefined,
	coordinator: string | undefined,
): string {
	if (current !== undefined && ticked.includes(current)) return current;
	if (coordinator !== undefined && ticked.includes(coordinator))
		return coordinator;
	return ticked[0] ?? "";
}

/** The permanent name of a new council from its display name, free among the groups there are; `council`, `council-2` … when the name has no letter or digit to make one of. */
export function slugFor(
	displayName: string,
	taken: ReadonlySet<string>,
): string {
	const base =
		displayName
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 28) || "council";
	if (!taken.has(base)) return base;
	for (let n = 2; ; n += 1) {
		const next = `${base}-${n}`;
		if (!taken.has(next)) return next;
	}
}
