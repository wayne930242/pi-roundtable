// How the room list is arranged: Home, then the pinned rooms in the owners' order, then the owners'
// folders in theirs, then everything else by latest activity. A pure function of the room list and the
// shared layout, so the rooms page and the switcher drawer agree and a test needs no browser.

import type { FolderView, RoomView } from "../../src/api-types.ts";

/** The dispatch threads of a room: the open ones and the finished ones, in list order. */
export interface ThreadKeys {
	open: string[];
	closed: string[];
}

export interface FolderSection {
	id: string;
	name: string;
	/** The folder's rooms that exist, in the owners' order. */
	rooms: string[];
}

export interface Sections {
	/** The coordinator's room, or none. */
	home: string[];
	pinned: string[];
	folders: FolderSection[];
	/** The rooms in no pin or folder, newest activity first. */
	rest: string[];
	/** `rest` split by kind, for the page that keeps Agents and Groups apart while there are no folders. */
	restAgents: string[];
	restGroups: string[];
	/** Threads by their room's key. */
	threads: Record<string, ThreadKeys>;
	/** Threads whose room the list no longer has. */
	orphans: ThreadKeys;
}

/** What the arrangement needs of the page's state. */
export interface SectionsInput {
	order: readonly string[];
	rooms: Readonly<Record<string, { view?: RoomView | undefined }>>;
	pins: readonly string[];
	folders: readonly FolderView[];
}

/**
 * `at` is a room's newest activity in epoch ms, or a number below any real one for a room with
 * none; a tie keeps the server's order.
 */
export function sections(
	state: SectionsInput,
	at: (key: string) => number,
): Sections {
	const views = new Map<string, RoomView>();
	for (const key of state.order) {
		const view = state.rooms[key]?.view;
		if (view) views.set(key, view);
	}
	const isRoom = (key: string) => {
		const view = views.get(key);
		return view !== undefined && view.kind !== "thread" && !view.home;
	};
	const taken = new Set<string>();
	/** Keeps the first mention of each room that exists and is not Home or a thread. */
	const claim = (keys: readonly string[]): string[] =>
		keys.filter((key) => {
			if (!isRoom(key) || taken.has(key)) return false;
			taken.add(key);
			return true;
		});
	const pinned = claim(state.pins);
	const folders = state.folders.map((folder) => ({
		id: folder.id,
		name: folder.name,
		rooms: claim(folder.rooms),
	}));
	const home: string[] = [];
	const threads: Record<string, ThreadKeys> = {};
	const orphans: ThreadKeys = { open: [], closed: [] };
	const listed = new Set(
		[...views].filter(([, view]) => view.kind !== "thread").map(([key]) => key),
	);
	const loose: { key: string; index: number; at: number }[] = [];
	let index = 0;
	for (const [key, view] of views) {
		index += 1;
		if (view.kind === "thread") {
			let into = orphans;
			if (view.parent && listed.has(view.parent)) {
				into = threads[view.parent] ?? { open: [], closed: [] };
				threads[view.parent] = into;
			}
			(view.closed ? into.closed : into.open).push(key);
		} else if (view.home) home.push(key);
		else if (!taken.has(key)) loose.push({ key, index, at: at(key) });
	}
	loose.sort((a, b) => (a.at === b.at ? a.index - b.index : b.at - a.at));
	const rest = loose.map((room) => room.key);
	const kindOf = (key: string) => views.get(key)?.kind;
	return {
		home,
		pinned,
		folders,
		rest,
		restAgents: rest.filter((key) => kindOf(key) === "agent"),
		restGroups: rest.filter((key) => kindOf(key) === "group"),
		threads,
		orphans,
	};
}

/** Whether the owners arranged anything: a pin or a folder. */
export const arranged = (sectionsOf: Pick<Sections, "pinned" | "folders">) =>
	sectionsOf.pinned.length > 0 || sectionsOf.folders.length > 0;

/** One run of rows in the room switcher; the heading is absent for the rooms that need none. */
export interface DrawerGroup {
	id: "waiting" | "pinned" | "rest" | string;
	/** A folder's name; a fixed group's heading is worded by the drawer. */
	title?: string;
	keys: string[];
}

/**
 * The rooms the switcher lists, in groups: those with a card waiting first, then the pinned rooms,
 * the folders, and the rest by latest activity (Home among them). Dispatch threads are reached
 * from their room and are not listed. A room shows once, in the first group that claims it.
 * `keepEmpty` keeps the pinned list and the empty folders, which a lifted room can be dropped in.
 */
export function drawerGroups(
	state: SectionsInput,
	at: (key: string) => number,
	waiting: (key: string) => boolean,
	keepEmpty = false,
): DrawerGroup[] {
	const arrangement = sections(state, at);
	const index = new Map(state.order.map((key, i) => [key, i]));
	const newest = (keys: readonly string[]) =>
		[...keys].sort((a, b) => {
			const x = at(a);
			const y = at(b);
			return x === y ? (index.get(a) ?? 0) - (index.get(b) ?? 0) : y - x;
		});
	const first = newest(
		[
			...arrangement.home,
			...arrangement.pinned,
			...arrangement.folders.flatMap((folder) => folder.rooms),
			...arrangement.rest,
		].filter(waiting),
	);
	const left = (keys: readonly string[]) =>
		keys.filter((key) => !first.includes(key));
	const groups: DrawerGroup[] = [
		{ id: "waiting", keys: first },
		{ id: "pinned", keys: left(arrangement.pinned) },
		...arrangement.folders.map((folder) => ({
			id: folder.id,
			title: folder.name,
			keys: left(folder.rooms),
		})),
		{
			id: "rest",
			keys: left(newest([...arrangement.home, ...arrangement.rest])),
		},
	];
	return groups.filter(
		(group) =>
			group.keys.length > 0 ||
			(keepEmpty && group.id !== "waiting" && group.id !== "rest"),
	);
}

/** Where a room stands in the arrangement, with the rooms shown beside it in the order they can be moved in. */
export type Place =
	| { kind: "pinned"; siblings: string[] }
	| { kind: "folder"; folder: string; siblings: string[] }
	| { kind: "rest" };

export function placeOf(
	arrangement: Pick<Sections, "pinned" | "folders">,
	room: string,
): Place {
	if (arrangement.pinned.includes(room))
		return { kind: "pinned", siblings: arrangement.pinned };
	const folder = arrangement.folders.find((one) => one.rooms.includes(room));
	return folder
		? { kind: "folder", folder: folder.id, siblings: folder.rooms }
		: { kind: "rest" };
}

export type MuteState = "none" | "some" | "all";

/** How many of a folder's rooms have their push muted: none, some, or all (an empty folder is none). */
export function muteState(
	keys: readonly string[],
	muted: (key: string) => boolean,
): MuteState {
	const count = keys.filter(muted).length;
	if (count === 0) return "none";
	return count === keys.length ? "all" : "some";
}
