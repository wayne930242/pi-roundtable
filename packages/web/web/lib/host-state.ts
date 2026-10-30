// What the page keeps beyond the room store: each room's unread count, where the other readers
// are, the host cards, and counters that say a room, a list of a kind or a page should be fetched
// again. It loads with the first frame that concerns it (see `frame-taps.ts`).

import type {
	HostCardView,
	ReadMarkView,
	RoomMessage,
	RoomView,
	ServerFrame,
} from "../../src/api-types.ts";
import { store } from "./app-store.ts";
import { signal } from "./signal.ts";

interface HostState {
	/** Messages past the person's read cursor, by room. */
	unread: Readonly<Record<string, number>>;
	/** Where the other readers of a room are. */
	reads: Readonly<Record<string, readonly ReadMarkView[]>>;
	/** The person's own cursor in a room, as far as the page knows it. */
	cursor: Readonly<Record<string, number>>;
	/** The host cards of a room, oldest first. */
	cards: Readonly<Record<string, readonly HostCardView[]>>;
	/** Counts of `room_changed`, `list_changed` and `page_changed`, by room, kind and page. */
	rooms: Readonly<Record<string, number>>;
	lists: Readonly<Record<string, number>>;
	pages: Readonly<Record<string, number>>;
}

let state: HostState = {
	unread: {},
	reads: {},
	cursor: {},
	cards: {},
	rooms: {},
	lists: {},
	pages: {},
};
const { emit, use, subscribe: subscribeHost } = signal();

export { subscribeHost };

function set(change: Partial<HostState>): void {
	state = { ...state, ...change };
	emit();
}

/** What a component reads of the host state; `select` returns a held value, never a new object. */
export const useHost = <T>(select: (current: HostState) => T): T =>
	use(() => select(state));

/** How many messages of a room the person has not read, as the page last counted them. */
export const unreadOf = (room: string): number => state.unread[room] ?? 0;

/** Every room's unread messages together, for the tab's title and icon. */
export const totalUnread = (): number =>
	Object.values(state.unread).reduce((sum, count) => sum + count, 0);

/** The rooms with something unread, each with how many messages. */
export function unreadCounts(): Record<string, number> {
	return Object.fromEntries(
		Object.entries(state.unread).filter(([, count]) => count > 0),
	);
}

const NONE: readonly never[] = [];
export const noReads: readonly ReadMarkView[] = NONE;
export const noCards: readonly HostCardView[] = NONE;

/** A message a person has to read: not a line the server wrote, not their own, not one still being written. */
function countsAsUnread(message: RoomMessage, me: string | undefined): boolean {
	return (
		message.kind !== "system" &&
		message.id !== 0 &&
		(message.principalId === undefined || message.principalId !== me)
	);
}

/** The room is open on screen and in view, so what arrives in it is read as it comes. */
const beingRead = (room: string): boolean =>
	store.getState().focus === room && document.visibilityState === "visible";

/** Counts of rooms the room list or a kind's list brought. */
export function seedUnread(counts: Readonly<Record<string, number>>): void {
	const next = { ...state.unread };
	for (const [room, count] of Object.entries(counts)) next[room] = count;
	set({ unread: next });
}

// The room list brings each agent room's count; a count the page already holds for the same view stays.
const seeded = new WeakSet<RoomView>();
function seedFromRooms(): void {
	let next: Record<string, number> | undefined;
	for (const [key, room] of Object.entries(store.getState().rooms)) {
		const view = room.view;
		if (!view || seeded.has(view)) continue;
		seeded.add(view);
		next ??= { ...state.unread };
		next[key] = view.unread ?? 0;
	}
	if (next) set({ unread: next });
}
store.subscribe(seedFromRooms);
seedFromRooms();

/** The marks and the person's cursor a fetch of a room's messages brought. */
export function keepReads(
	room: string,
	reads: readonly ReadMarkView[] | undefined,
	cursor: number | undefined,
): void {
	const change: Partial<HostState> = {};
	if (reads) change.reads = { ...state.reads, [room]: reads };
	if (cursor !== undefined && cursor > (state.cursor[room] ?? 0))
		change.cursor = { ...state.cursor, [room]: cursor };
	if (change.reads || change.cursor) set(change);
}

/** The cards the room's fetch brought. */
export function keepCards(room: string, cards: readonly HostCardView[]): void {
	set({ cards: { ...state.cards, [room]: cards } });
}

const bump = (counters: Readonly<Record<string, number>>, key: string) => ({
	...counters,
	[key]: (counters[key] ?? 0) + 1,
});

/** Applies a frame that concerns reading or a host room. */
export function onFrame(frame: ServerFrame): void {
	switch (frame.type) {
		case "message":
		case "host_message": {
			const me = store.getState().principal?.id;
			if (!countsAsUnread(frame.message, me) || beingRead(frame.room)) return;
			set({
				unread: {
					...state.unread,
					[frame.room]: (state.unread[frame.room] ?? 0) + 1,
				},
			});
			return;
		}
		case "read": {
			const { room, principal, upTo } = frame;
			if (principal === store.getState().principal?.id) {
				const later = (store.getState().rooms[room]?.messages ?? []).filter(
					(message) => message.id > upTo && countsAsUnread(message, principal),
				).length;
				set({
					unread: { ...state.unread, [room]: later },
					cursor: {
						...state.cursor,
						[room]: Math.max(upTo, state.cursor[room] ?? 0),
					},
				});
				return;
			}
			const others = (state.reads[room] ?? NONE).filter(
				(mark) => mark.principal !== principal,
			);
			const before = state.reads[room]?.find(
				(mark) => mark.principal === principal,
			);
			if (before && before.upTo >= upTo) return;
			set({
				reads: {
					...state.reads,
					[room]: [
						...others,
						{ principal, name: frame.name, upTo, at: frame.at },
					],
				},
			});
			return;
		}
		case "host_card": {
			const held = (state.cards[frame.room] ?? NONE).filter(
				(card) => card.id !== frame.card.id,
			);
			set({
				cards: {
					...state.cards,
					[frame.room]: [...held, frame.card].sort((a, b) =>
						a.at < b.at ? -1 : a.at > b.at ? 1 : 0,
					),
				},
			});
			return;
		}
		case "room_changed":
			set({ rooms: bump(state.rooms, frame.room) });
			return;
		case "list_changed":
			set({ lists: bump(state.lists, frame.kind) });
			return;
		case "page_changed":
			set({ pages: bump(state.pages, frame.page) });
			return;
		default:
			return;
	}
}
