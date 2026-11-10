// What the chat home shows, as plain functions of the arrangement (`sections`): the pins, the folder
// chips, the one list a chip filters (Home leads all of it unless pinned), and the badge a pin carries. Nothing here touches the
// page or the clock, so a test needs no browser.

import type { Sections } from "./sections.ts";

/** One chip above the list: everything, a folder, or the rooms in no folder. */
export interface Chip {
	id: string;
	kind: "all" | "folder" | "other";
	/** A folder's own name; the two fixed chips are worded by the page. */
	name?: string;
	/** The rooms the chip filters to, for the dot of unread rooms. */
	rooms: readonly string[];
}

/** The pinned rooms in the owners' order; Home is one only while the owners have it pinned, else it leads the list of all. */
export const pinsOf = (arrangement: Pick<Sections, "pinned">) => [
	...arrangement.pinned,
];

type ListInput = Pick<Sections, "home" | "folders" | "rest">;

/** Every room the chat list can show: Home, those in a folder and those in none. */
const everyRoom = (arrangement: ListInput): string[] => [
	...arrangement.home,
	...arrangement.rest,
	...arrangement.folders.flatMap((folder) => folder.rooms),
];

/** The chips: none without a folder; else all, each folder in order, and the rest when any room is in none. */
export function chipsOf(arrangement: ListInput): Chip[] {
	if (arrangement.folders.length === 0) return [];
	return [
		{
			id: "all",
			kind: "all",
			rooms: everyRoom(arrangement),
		},
		...arrangement.folders.map((folder) => ({
			id: folder.id,
			kind: "folder" as const,
			name: folder.name,
			rooms: folder.rooms,
		})),
		...(arrangement.rest.length > 0
			? [{ id: "other", kind: "other" as const, rooms: arrangement.rest }]
			: []),
	];
}

/**
 * The rooms a chip lists, newest activity first, a tie in the server's `order`; all of them (and an
 * unknown chip, a folder deleted meanwhile) start with Home whatever its activity. The pinned and the
 * hidden rooms are in none of the chips, and Home is in no folder.
 */
export function listFor(
	arrangement: ListInput,
	chip: string,
	at: (key: string) => number,
	order: readonly string[],
): string[] {
	const found = chipsOf(arrangement).find((one) => one.id === chip);
	if (found && found.kind !== "all") return newestFirst(found.rooms, at, order);
	const home = new Set(arrangement.home);
	const others = everyRoom(arrangement).filter((key) => !home.has(key));
	return [...arrangement.home, ...newestFirst(others, at, order)];
}

/** `keys` by latest activity, a tie in the server's `order`. */
function newestFirst(
	keys: readonly string[],
	at: (key: string) => number,
	order: readonly string[],
): string[] {
	const index = new Map(order.map((key, place) => [key, place]));
	return [...keys].sort((a, b) => {
		const x = at(a);
		const y = at(b);
		return x === y ? (index.get(a) ?? 0) - (index.get(b) ?? 0) : y - x;
	});
}

/** The unread messages in a chip's rooms. */
export const chipUnread = (
	chip: Pick<Chip, "rooms">,
	unread: Readonly<Record<string, number>>,
): number => chip.rooms.reduce((sum, key) => sum + (unread[key] ?? 0), 0);

/** A room listed under a chip that is not its own, with the folder it belongs to (none for the rest). */
export interface Elsewhere {
	key: string;
	folder?: { id: string; name: string };
}

/**
 * With a folder (or the rest) chip active: the rooms of the other folders and of none that have
 * something unread, newest first. All lists every room already, so it has none; a room that is read
 * is back in its own chip only.
 */
export function elsewhereUnread(
	arrangement: ListInput,
	chip: string,
	unread: Readonly<Record<string, number>>,
	at: (key: string) => number,
	order: readonly string[],
): Elsewhere[] {
	if (chip === "all" || !chipsOf(arrangement).some((one) => one.id === chip))
		return [];
	const owner = new Map<string, Elsewhere>();
	for (const key of [...arrangement.home, ...arrangement.rest])
		owner.set(key, { key });
	for (const folder of arrangement.folders)
		for (const key of folder.rooms)
			owner.set(key, { key, folder: { id: folder.id, name: folder.name } });
	const own = new Set(
		chip === "other"
			? arrangement.rest
			: (arrangement.folders.find((one) => one.id === chip)?.rooms ?? []),
	);
	const keys = [...owner.keys()].filter(
		(key) => !own.has(key) && (unread[key] ?? 0) > 0,
	);
	return newestFirst(keys, at, order).map((key) => owner.get(key) as Elsewhere);
}

/** The folder a room is in, for the tag on its row. */
export const folderOf = (
	arrangement: Pick<Sections, "folders">,
	key: string,
): { id: string; name: string } | undefined => {
	const folder = arrangement.folders.find((one) => one.rooms.includes(key));
	return folder ? { id: folder.id, name: folder.name } : undefined;
};

/**
 * Every room in the order the chat home shows them: the pins, then the list of all (Home first, the
 * rest by latest activity), then the hidden rooms. The switcher and the search list rooms in this order.
 */
export const homeOrder = (
	arrangement: Sections,
	at: (key: string) => number,
	order: readonly string[],
): string[] => [
	...pinsOf(arrangement),
	...listFor(arrangement, "all", at, order),
	...arrangement.hidden,
];

/** What a pin shows in its corner: the count of cards waiting, else unread messages, else a dot while it works. */
export type PinBadge =
	| { kind: "waiting" | "unread"; count: number }
	| { kind: "typing" };

/** A pin is drawn large only in the phone home's dock, with no room open; a column or an open room keeps it small. */
export function pinSizeOf(where: {
	column?: boolean;
	active?: string | undefined;
}): 80 | 56 {
	return where.column || where.active !== undefined ? 56 : 80;
}

export function pinBadge(
	waiting: number,
	unread: number,
	typing: boolean,
): PinBadge | undefined {
	if (waiting > 0) return { kind: "waiting", count: waiting };
	if (unread > 0) return { kind: "unread", count: unread };
	return typing ? { kind: "typing" } : undefined;
}
