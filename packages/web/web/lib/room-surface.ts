// What every view of a room takes from the state, so the views differ in how they lay a room out
// and never in what they show. The chat (`room-log.tsx`) and the scene's dialogue box
// (`dialogue-box.tsx`) are two such views of one room; each takes the room's cards from
// `roomCards` and draws each with `RoomCardSlot`, and `room-surface.test.tsx` holds every view to
// the same parts.

import type { CardState, RoomsState } from "./rooms.ts";

/** A card a room's views show: one of the room's own, or one carried up from a room under it (`from`). */
export interface RoomCard {
	id: string;
	card: CardState;
	/** The thread's or temp knight's room the card was asked in, when it is not this room. */
	from?: string;
}

type CardParts = Pick<RoomsState, "rooms" | "cards" | "cardOrder">;

/** The room a dispatch thread or a temp knight's room hangs under; none for any other room. */
function parentOf(state: Pick<RoomsState, "rooms">, key: string) {
	const view = state.rooms[key]?.view;
	return view?.parent ?? view?.helper?.parent;
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

/**
 * The cards a view of the room shows, in the order they opened. The room's own come all, ended
 * ones too: each view keeps its own record of them. A card asked in a thread or temp knight's room
 * under it comes while it waits, and once ended until the room says something newer, so a person
 * answers where they are and sees the answer land; its record stays in the room it was asked in.
 */
export function roomCards(state: CardParts, key: string): RoomCard[] {
	const newest = Date.parse(state.rooms[key]?.messages.at(-1)?.at ?? "");
	return state.cardOrder.flatMap((id): RoomCard[] => {
		const card = state.cards[id];
		if (!card) return [];
		if (card.room === key) return [{ id, card }];
		if (!hangsUnder(state, card.room, key)) return [];
		if (card.outcome !== undefined) {
			const closed = Date.parse(card.closedAt ?? "");
			if (Number.isNaN(closed) || closed < newest) return [];
		}
		return [{ id, card, from: card.room }];
	});
}

/** How many of the cards a view of the room shows wait for an answer. */
export function roomWaiting(state: CardParts, key: string): number {
	return roomCards(state, key).filter(({ card }) => card.outcome === undefined)
		.length;
}
