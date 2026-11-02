// What every view of a room takes from the state, so the views differ in how they lay a room out
// and never in what they show. The chat (`room-log.tsx`) and the scene's dialogue box
// (`dialogue-box.tsx`) are two such views of one room; each takes the room's cards from
// `roomCards` and draws each with `RoomCardBody` (`components/room-card.tsx`), and
// `room-views.test.tsx` holds every view to the same parts.

import type { CardState, RoomsState } from "./rooms.ts";

/** A card a room's views show: one of the room's own, or one carried up from a room under it (`from`). */
export interface RoomCard {
	id: string;
	card: CardState;
	/** The thread's or temp knight's room the card was asked in, when it is not this room. */
	from?: string;
}

type CardParts = Pick<RoomsState, "rooms" | "cards" | "cardOrder">;

/**
 * The room a dispatch thread or a temp knight's room hangs under; none for any other room. A temp
 * knight hangs under the room it was made from (a group's, when a member made it in the group's
 * round), where its answer goes too, else under its knight's room.
 */
function parentOf(state: Pick<RoomsState, "rooms">, key: string) {
	const view = state.rooms[key]?.view;
	return view?.parent ?? view?.helper?.origin ?? view?.helper?.parent;
}

/** Whether `room` hangs under `above`, through any number of threads and temp knights. */
export function hangsUnder(
	state: Pick<RoomsState, "rooms">,
	room: string,
	above: string,
): boolean {
	const seen = new Set<string>();
	for (
		let at = parentOf(state, room);
		at !== undefined && !seen.has(at);
		at = parentOf(state, at)
	) {
		if (at === above) return true;
		seen.add(at);
	}
	return false;
}

/** When the room last said something, in epoch ms; NaN while it shows no message. */
const newestAt = (state: Pick<RoomsState, "rooms">, key: string): number =>
	Date.parse(state.rooms[key]?.messages.at(-1)?.at ?? "");

/** Whether an ended card still shows in a room above its own: it ended after that room last spoke. */
function endedSince(card: CardState, newest: number): boolean {
	const closed = Date.parse(card.closedAt ?? "");
	// A room with no message yet (its history still on the way) has nothing to measure against.
	return !Number.isNaN(closed) && !Number.isNaN(newest) && closed >= newest;
}

/**
 * Whether a room above the ended card's own still shows it, so the page must keep it however its
 * own room trims its cards.
 */
export function shownAbove(
	state: Pick<RoomsState, "rooms">,
	card: CardState,
): boolean {
	if (card.outcome === undefined) return false;
	const seen = new Set<string>();
	for (
		let at = parentOf(state, card.room);
		at !== undefined && !seen.has(at);
		at = parentOf(state, at)
	) {
		if (endedSince(card, newestAt(state, at))) return true;
		seen.add(at);
	}
	return false;
}

/**
 * The entries in the order their cards opened, by the server's clock: the state's order is the
 * order the page heard of them, and a reload hears the open ones after the ended ones the history
 * brings. A card without a time keeps its place.
 */
function byOpening(entries: RoomCard[]): RoomCard[] {
	const at = (entry: RoomCard) => Date.parse(entry.card.frame.at ?? "");
	const timed = entries
		.filter((entry) => !Number.isNaN(at(entry)))
		.sort((a, b) => at(a) - at(b));
	let next = 0;
	return entries.map((entry) =>
		Number.isNaN(at(entry)) ? entry : (timed[next++] ?? entry),
	);
}

/**
 * The cards a view of the room shows, in the order they opened. The room's own come all, ended
 * ones too: each view keeps its own record of them. A card asked in a thread or temp knight's room
 * under it comes while it waits, and once ended until the room says something newer (never while
 * the room shows no message), so a person answers where they are and sees the answer land; its
 * record stays in the room it was asked in.
 */
export function roomCards(state: CardParts, key: string): RoomCard[] {
	const newest = newestAt(state, key);
	return byOpening(
		state.cardOrder.flatMap((id): RoomCard[] => {
			const card = state.cards[id];
			if (!card) return [];
			if (card.room === key) return [{ id, card }];
			if (!hangsUnder(state, card.room, key)) return [];
			if (card.outcome !== undefined && !endedSince(card, newest)) return [];
			return [{ id, card, from: card.room }];
		}),
	);
}

/** How many of the cards a view of the room shows wait for an answer. */
export function roomWaiting(state: CardParts, key: string): number {
	return roomCards(state, key).filter(({ card }) => card.outcome === undefined)
		.length;
}
