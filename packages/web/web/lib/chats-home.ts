// What the chat home shows, as plain functions of the arrangement (`sections`): the pins on top, the
// folder chips, the one list a chip filters, and the badge a pin carries. Nothing here touches the
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

/** Home first, then the pinned rooms in the owners' order. */
export const pinsOf = (arrangement: Pick<Sections, "home" | "pinned">) => [
	...arrangement.home,
	...arrangement.pinned,
];

type ListInput = Pick<Sections, "folders" | "rest">;

/** Every room the chat list can show: those in a folder and those in none. */
const everyRoom = (arrangement: ListInput): string[] => [
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
 * The rooms a chip lists, newest activity first, a tie in the server's `order`. The pinned and the
 * hidden rooms are in none of the chips; an unknown chip (a folder deleted meanwhile) lists everything.
 */
export function listFor(
	arrangement: ListInput,
	chip: string,
	at: (key: string) => number,
	order: readonly string[],
): string[] {
	const found = chipsOf(arrangement).find((one) => one.id === chip);
	const keys = found?.rooms ?? everyRoom(arrangement);
	const index = new Map(order.map((key, place) => [key, place]));
	return [...keys].sort((a, b) => {
		const x = at(a);
		const y = at(b);
		return x === y ? (index.get(a) ?? 0) - (index.get(b) ?? 0) : y - x;
	});
}

/**
 * Every room in the order the chat home shows them: Home and the pins, then the one list by latest
 * activity, then the hidden rooms. The switcher and the search list rooms in this order.
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

export function pinBadge(
	waiting: number,
	unread: number,
	typing: boolean,
): PinBadge | undefined {
	if (waiting > 0) return { kind: "waiting", count: waiting };
	if (unread > 0) return { kind: "unread", count: unread };
	return typing ? { kind: "typing" } : undefined;
}

/** Whether a hidden room has something unread, which lights the dot of the row that holds them. */
export const hiddenDot = (
	hidden: readonly string[],
	unread: Readonly<Record<string, number>>,
): boolean => hidden.some((key) => (unread[key] ?? 0) > 0);
