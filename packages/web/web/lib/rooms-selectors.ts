import type { RoomFile, RoomMessage, RoomMode } from "../../src/api-types.ts";
import { type RoomCard, roomCards } from "./room-surface.ts";
import type { CardState, PendingSend, RoomsState } from "./rooms-types.ts";

// ── What the pages read ──────────────────────────────────────────────────────────────────────────

/** How many cards of the room wait for an answer. */
export function waitingCards(state: RoomsState, room: string): number {
	return state.cardOrder.filter((id) => {
		const card = state.cards[id];
		return card?.room === room && !card.outcome;
	}).length;
}

/**
 * The rooms the switcher lists: those with a card waiting for an answer first, then the rest, each
 * group by its newest message (a room without one last, in the server's order). Dispatch threads
 * are reached from their room and are not listed.
 */
export function switcherOrder(state: RoomsState): string[] {
	const rooms = state.order.flatMap((key, index) => {
		const view = state.rooms[key]?.view;
		if (!view || view.kind === "thread") return [];
		const at = Date.parse(lastMessage(state, key)?.at ?? "");
		return [
			{
				key,
				index,
				waiting: waitingCards(state, key) > 0,
				at: Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at,
			},
		];
	});
	return rooms
		.sort(
			(a, b) =>
				Number(b.waiting) - Number(a.waiting) ||
				(a.at === b.at ? a.index - b.index : b.at - a.at),
		)
		.map((room) => room.key);
}

/** The banner a room shows while a mode is on; none when both are off. */
export function banner(state: RoomsState, room: string): RoomMode | undefined {
	const mode = state.rooms[room]?.mode;
	return mode && (mode.yolo || mode.longRunning) ? mode : undefined;
}

/** The room's newest message: the newer of what frames brought and what the list says. */
export function lastMessage(
	state: RoomsState,
	room: string,
): RoomMessage | undefined {
	const state_ = state.rooms[room];
	const seen = state_?.messages.at(-1);
	const listed = state_?.view?.last;
	return seen && listed
		? seen.id >= listed.id
			? seen
			: listed
		: (seen ?? listed);
}

/** When the room last said something, in epoch ms; a number below any real one for a room that has not. */
export function activityAt(state: RoomsState, room: string): number {
	const at = Date.parse(lastMessage(state, room)?.at ?? "");
	return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}

/**
 * Whether a card opened before a message was stored. Both carry the server's clock, which is what
 * places a card the server sent again after a reload; a card without a time stands after the
 * message that was last when it opened.
 */
export function opensBefore(card: CardState, message: RoomMessage): boolean {
	const opened = Date.parse(card.frame.at ?? "");
	const stored = Date.parse(message.at);
	if (!Number.isNaN(opened) && !Number.isNaN(stored)) return opened < stored;
	return card.after < message.id;
}

export type TimelineItem =
	| { kind: "message"; message: RoomMessage }
	| { kind: "card"; card: CardState; id: string; from?: string }
	| { kind: "pending"; pending: PendingSend }
	| { kind: "live"; message: RoomMessage };

/** What the room shows top to bottom: stored messages with cards in place, then what is on its way. */
export function timeline(
	state: Pick<RoomsState, "rooms" | "cards" | "cardOrder">,
	key: string,
): TimelineItem[] {
	const room = state.rooms[key];
	if (!room) return [];
	// A card carried up from another room without a time cannot be placed among this room's
	// messages: it stands at the end, outside the merge, so it holds no later card back.
	const unplaced = (entry: RoomCard) =>
		entry.from !== undefined &&
		Number.isNaN(Date.parse(entry.card.frame.at ?? ""));
	const all = roomCards(state, key);
	const cards = all.filter((entry) => !unplaced(entry));
	const items: TimelineItem[] = [];
	let placed = 0;
	/** Cards that opened before `next` (or all, at the end) stand here. */
	const cardsBefore = (next: RoomMessage | undefined) => {
		while (placed < cards.length) {
			const entry = cards[placed];
			if (!entry || (next && !opensBefore(entry.card, next))) break;
			items.push({
				kind: "card",
				card: entry.card,
				id: entry.id,
				...(entry.from ? { from: entry.from } : {}),
			});
			placed += 1;
		}
	};
	const shown = room.messages;
	cardsBefore(shown[0]);
	shown.forEach((message, index) => {
		items.push({ kind: "message", message });
		cardsBefore(shown[index + 1]);
	});
	cardsBefore(undefined);
	for (const entry of all.filter(unplaced))
		items.push({
			kind: "card",
			card: entry.card,
			id: entry.id,
			...(entry.from ? { from: entry.from } : {}),
		});
	for (const pending of room.pending) items.push({ kind: "pending", pending });
	for (const message of room.live) items.push({ kind: "live", message });
	return items;
}

/** A file's address under the mount, for a link or an image. */
export const fileUrl = (file: Pick<RoomFile, "id">): string =>
	`api/files/${encodeURIComponent(file.id)}`;

/** Where a stored message's files download as one zip. */
export const messageZipUrl = (
	message: Pick<RoomMessage, "room" | "id">,
): string =>
	`api/files/zip?room=${encodeURIComponent(message.room)}&message=${message.id}`;
