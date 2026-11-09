import type {
	ActivityPhase,
	ClosedCard,
	FolderView,
	RoomMessage,
	RoomView,
	ServerFrame,
} from "../../src/api-types.ts";
import { isStartOver } from "../../src/api-types.ts";
import { shownAbove } from "./room-surface.ts";
import { opensBefore } from "./rooms-selectors.ts";
import type { LocalAction, RoomState, RoomsState } from "./rooms-types.ts";
import {
	blank,
	KEPT_RESOLVED_CARDS,
	NO_PROGRESS,
	PROGRESS_TEXT_CHARS,
	PROGRESS_TOOLS,
	ROOM_PAGE,
} from "./rooms-types.ts";

/** The state with one room changed; the room is made if it is new. */
export function withRoom(
	state: RoomsState,
	key: string,
	change: (room: RoomState) => RoomState,
): RoomsState {
	const room = state.rooms[key] ?? blank(key);
	return { ...state, rooms: { ...state.rooms, [key]: change(room) } };
}

/** `messages` with `incoming` added in id order, once each. */
export function merged(
	messages: readonly RoomMessage[],
	incoming: readonly RoomMessage[],
): RoomMessage[] {
	// The usual case, a message newer than all held: no lookup and no sort.
	let last = messages.at(-1)?.id ?? Number.NEGATIVE_INFINITY;
	if (
		incoming.every((message) => {
			const newer = message.id > last;
			last = message.id;
			return newer;
		})
	)
		return incoming.length === 0
			? (messages as RoomMessage[])
			: [...messages, ...incoming];
	const known = new Set(messages.map((message) => message.id));
	const added = incoming.filter((message) => {
		if (known.has(message.id)) return false;
		known.add(message.id);
		return true;
	});
	if (added.length === 0) return messages as RoomMessage[];
	return [...messages, ...added].sort((a, b) => a.id - b.id);
}

/** A room trimmed to its latest page, with the rest left to be fetched when the page opens it again. */
export function trimmed(room: RoomState): RoomState {
	if (room.messages.length <= ROOM_PAGE) return room;
	return { ...room, messages: room.messages.slice(-ROOM_PAGE), more: true };
}

/**
 * The state without the ended cards the page need not hold: those of a room whose older messages
 * it left out and that opened before the first one it keeps (the history brings them back with
 * those messages), and all but the newest few of a room it holds no message of.
 */
export function resolvedPruned(state: RoomsState): RoomsState {
	const drop = new Set<string>();
	const without = new Map<string, string[]>();
	for (const id of state.cardOrder) {
		const card = state.cards[id];
		// A card a room above its own still shows stays until that room moves on.
		if (!card?.outcome || shownAbove(state, card)) continue;
		const room = state.rooms[card.room];
		const first = room?.messages[0];
		if (first) {
			if (room.more && opensBefore(card, first)) drop.add(id);
		} else without.set(card.room, [...(without.get(card.room) ?? []), id]);
	}
	for (const ids of without.values())
		for (const id of ids.slice(0, ids.length - KEPT_RESOLVED_CARDS))
			drop.add(id);
	if (drop.size === 0) return state;
	return {
		...state,
		cardOrder: state.cardOrder.filter((id) => !drop.has(id)),
		cards: Object.fromEntries(
			Object.entries(state.cards).filter(([id]) => !drop.has(id)),
		),
	};
}

/** The state with the cards the history brought, each in place by the time it opened and as it ended. */
export function withClosedCards(
	state: RoomsState,
	room: string,
	closed: readonly ClosedCard[],
): RoomsState {
	if (closed.length === 0) return state;
	const held = state.rooms[room]?.messages ?? [];
	const cards = { ...state.cards };
	const order = [...state.cardOrder];
	for (const one of closed) {
		const id = one.frame.id;
		const opened = Date.parse(one.frame.at ?? "");
		const known = cards[id];
		cards[id] = {
			room: one.room,
			frame: one.frame,
			after: known
				? known.after
				: (held.findLast((m) => Date.parse(m.at) <= opened)?.id ?? 0),
			outcome: one.outcome,
			...(one.note ? { note: one.note } : {}),
			...(one.by ? { by: one.by } : {}),
			...(one.answer ? { answer: one.answer } : {}),
			closedAt: one.closedAt,
		};
		if (known) continue;
		const at = order.findIndex((other) => {
			const time = Date.parse(cards[other]?.frame.at ?? "");
			return !Number.isNaN(opened) && time > opened;
		});
		if (at < 0) order.push(id);
		else order.splice(at, 0, id);
	}
	return { ...state, cards, cardOrder: order };
}

export function onProgress(
	state: RoomsState,
	frame: Extract<ServerFrame, { type: "progress" }>,
): RoomsState {
	// The server streams only to the focused room; a frame from before a switch is ignored too.
	if (state.focus !== frame.room) return state;
	return withRoom(state, frame.room, (room) => {
		const { event } = frame;
		const { text, tools } = room.progress;
		switch (event.type) {
			case "text":
				return {
					...room,
					progress: {
						text: (text + event.delta).slice(-PROGRESS_TEXT_CHARS),
						tools,
					},
				};
			case "tool_start":
				return {
					...room,
					progress: {
						text,
						tools: [
							...tools.filter((chip) => chip.id !== event.id),
							{
								id: event.id,
								tool: event.tool,
								...(event.preview ? { preview: event.preview } : {}),
								status: "running" as const,
							},
						].slice(-PROGRESS_TOOLS),
					},
				};
			case "tool_end":
				return {
					...room,
					progress: {
						text,
						tools: tools.map((chip) =>
							chip.id === event.id
								? {
										...chip,
										status: event.refused
											? ("refused" as const)
											: event.ok
												? ("ok" as const)
												: ("failed" as const),
										...(event.refused ? { refused: event.refused } : {}),
									}
								: chip,
						),
					},
				};
		}
	});
}

export function onMessage(
	state: RoomsState,
	roomKey: string,
	message: RoomMessage,
	accepted?: string,
): RoomsState {
	const updated = withRoom(state, roomKey, (room) => {
		const pending = accepted
			? room.pending.filter((one) => one.id !== accepted)
			: room.pending;
		// A live message has no stored id; a later frame with its token replaces it.
		if (message.id === 0 && message.live) {
			const live = room.live.some((one) => one.live === message.live)
				? room.live.map((one) => (one.live === message.live ? message : one))
				: [...room.live, message];
			return { ...room, live, pending };
		}
		// A message between agents is a card beside the turn, never its reply.
		const replies = message.kind === "agent" && !message.intercom;
		const next = {
			...room,
			messages: merged(room.messages, [message]),
			// The agent's final reply stands in for what it showed live.
			live: replies
				? room.live.filter((one) => one.agent !== message.agent)
				: room.live,
			progress: replies ? NO_PROGRESS : room.progress,
			pending,
		};
		return state.focus === roomKey ? next : trimmed(next);
	});
	// A room the page left trimmed gives up the cards that stood before what it kept.
	return state.focus === roomKey ? updated : resolvedPruned(updated);
}

/**
 * The state with the room shown from its latest start-over line on: what came before belongs to the
 * archived conversation, so its messages and its ended cards go, and no older page is offered.
 */
export function fromStart(state: RoomsState, key: string): RoomsState {
	const room = state.rooms[key];
	if (!room) return state;
	const at = room.messages.findLastIndex(isStartOver);
	const line = room.messages[at];
	if (!line || (at === 0 && !room.more)) return state;
	const old = (id: string) => {
		const card = state.cards[id];
		return card?.room === key && !!card.outcome && card.after < line.id;
	};
	return {
		...state,
		rooms: {
			...state.rooms,
			[key]: { ...room, messages: room.messages.slice(at), more: false },
		},
		cardOrder: state.cardOrder.filter((id) => !old(id)),
		cards: Object.fromEntries(
			Object.entries(state.cards).filter(([id]) => !old(id)),
		),
	};
}

export function onHistory(
	state: RoomsState,
	frame: Extract<LocalAction, { type: "history_loaded" }>,
): RoomsState {
	return withRoom(state, frame.room, (room) => {
		if (frame.older)
			return {
				...room,
				messages: merged(room.messages, frame.messages),
				more: frame.more,
			};
		const first = frame.messages[0];
		const newest = room.messages.at(-1);
		// A latest page that starts after everything we hold leaves a gap that would hide messages.
		if (first && newest && first.id > newest.id)
			return { ...room, messages: [...frame.messages], more: frame.more };
		return {
			...room,
			messages: merged(room.messages, frame.messages),
			more: first && newest ? room.more || frame.more : frame.more,
		};
	});
}

/** The room with its turn set: the phase and the speaker are kept only while the turn runs. */
export function withTurn(
	room: RoomState,
	turn: {
		typing: boolean;
		phase?: ActivityPhase | undefined;
		agent?: string | undefined;
	},
): RoomState {
	const { phase: _phase, agent: _agent, ...rest } = room;
	return {
		...rest,
		typing: turn.typing,
		...(turn.typing && turn.phase ? { phase: turn.phase } : {}),
		...(turn.typing && turn.agent ? { agent: turn.agent } : {}),
	};
}

export function onRooms(
	state: RoomsState,
	rooms: readonly RoomView[],
	layout: { pins?: string[] | undefined; folders?: FolderView[] | undefined },
): RoomsState {
	let next: RoomsState = {
		...state,
		listed: true,
		pins: layout.pins ?? state.pins,
		folders: layout.folders ?? state.folders,
	};
	for (const view of rooms)
		next = withRoom(next, view.key, (room) => {
			const { round: held, ...rest } = withTurn(room, view);
			// The list says what runs now; a round that ended is only in the page's memory.
			const round = view.round ?? (held?.state === "ended" ? held : undefined);
			return {
				...rest,
				...(round ? { round } : {}),
				view,
				mode: view.mode,
				stoppable: view.stoppable,
			};
		});
	return { ...next, order: rooms.map((view) => view.key) };
}
