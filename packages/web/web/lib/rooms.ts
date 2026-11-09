import { isStartOver } from "../../src/api-types.ts";

import {
	fromStart,
	onHistory,
	onMessage,
	onProgress,
	onRooms,
	resolvedPruned,
	trimmed,
	withClosedCards,
	withRoom,
	withTurn,
} from "./rooms-handlers.ts";
import type { Action, RoomState, RoomsState } from "./rooms-types.ts";
import { NO_PROGRESS } from "./rooms-types.ts";

export * from "./rooms-selectors.ts";
export * from "./rooms-types.ts";
export type { ToolChip } from "./tool-chip.ts";

/** The next state for a frame of the server or an action of the page. */
export function reduce(state: RoomsState, action: Action): RoomsState {
	switch (action.type) {
		case "connection":
			return { ...state, connection: action.status };
		case "forbidden":
			return { ...state, forbidden: true, connection: "closed" };
		case "ready": {
			// The server sends every open card again right after `ready`, so the open ones go.
			const gone = new Set(
				state.cardOrder.filter((id) => !state.cards[id]?.outcome),
			);
			return {
				...state,
				connection: "open",
				principal: { id: action.principal, name: action.name },
				limits: action.uploads,
				connects: state.connects + 1,
				gate: action.gate ?? [],
				cardOrder: state.cardOrder.filter((id) => !gone.has(id)),
				cards: Object.fromEntries(
					Object.entries(state.cards).filter(([id]) => !gone.has(id)),
				),
			};
		}
		case "accepted":
			return onMessage(state, action.room, action.message, action.id);
		case "refused": {
			const { id, prompt } = action;
			if (id === undefined) {
				const card = prompt === undefined ? undefined : state.cards[prompt];
				return {
					...state,
					refusal: action.code,
					...(prompt !== undefined && card
						? {
								cards: {
									...state.cards,
									[prompt]: { ...card, refused: (card.refused ?? 0) + 1 },
								},
							}
						: {}),
				};
			}
			return {
				...state,
				rooms: Object.fromEntries(
					Object.entries(state.rooms).map(([key, room]) => [
						key,
						room.pending.some((one) => one.id === id)
							? {
									...room,
									pending: room.pending.map((one) =>
										one.id === id ? { ...one, failed: action.code } : one,
									),
								}
							: room,
					]),
				),
			};
		}
		case "message":
		case "host_message": {
			const next = onMessage(state, action.room, action.message);
			// A start-over clears the room on every page that shows it.
			return isStartOver(action.message) ? fromStart(next, action.room) : next;
		}
		case "host_removed":
			return withRoom(state, action.room, (room) => ({
				...room,
				messages: room.messages.filter((one) => one.id !== action.id),
			}));
		case "edited":
		case "host_edited":
			// A message not held (older than the page) is fetched with its new text when it is needed.
			return withRoom(state, action.room, (room) => ({
				...room,
				messages: room.messages.map((one) =>
					one.id === action.message.id ? action.message : one,
				),
			}));
		case "progress":
			return onProgress(state, action);
		case "round":
			return withRoom(state, action.room, (room) => ({
				...room,
				round: action.round,
			}));
		case "activity":
			return withRoom(state, action.room, (room) => {
				const next: RoomState = {
					...withTurn(room, action),
					stoppable: action.stoppable,
					...(action.at === undefined ? {} : { activityAt: action.at }),
				};
				if (action.typing) {
					// A new turn ends the story of the last one.
					const { outcome: _outcome, outcomeAt: _at, ...running } = next;
					return running;
				}
				return {
					...next,
					progress: NO_PROGRESS,
					live: [],
					...(action.outcome
						? {
								outcome: action.outcome,
								...(action.at === undefined ? {} : { outcomeAt: action.at }),
							}
						: {}),
				};
			});
		case "prompt": {
			const known = state.cards[action.prompt.id];
			const after = known
				? known.after
				: (state.rooms[action.room]?.messages.at(-1)?.id ?? 0);
			return {
				...withRoom(state, action.room, (room) => room),
				cards: {
					...state.cards,
					[action.prompt.id]: {
						room: action.room,
						frame: action.prompt,
						after,
					},
				},
				cardOrder: known
					? state.cardOrder
					: [...state.cardOrder, action.prompt.id],
			};
		}
		case "prompt_closed": {
			const card = state.cards[action.prompt];
			if (!card) return state;
			return resolvedPruned({
				...state,
				cards: {
					...state.cards,
					[action.prompt]: {
						...card,
						outcome: action.outcome,
						...(action.note ? { note: action.note } : {}),
						...(action.by ? { by: action.by } : {}),
						...(action.answer ? { answer: action.answer } : {}),
						...(action.closedAt ? { closedAt: action.closedAt } : {}),
					},
				},
			});
		}
		case "mode":
			return withRoom(state, action.room, (room) => ({
				...room,
				mode: {
					yolo: action.yolo,
					longRunning: action.longRunning,
					...(action.inheritedFrom === undefined
						? {}
						: { inheritedFrom: action.inheritedFrom }),
				},
			}));
		case "auto_approved":
			return withRoom(state, action.room, (room) => ({
				...room,
				autoApproved: room.autoApproved + 1,
			}));
		case "changed":
			return { ...state, revision: state.revision + 1 };
		case "presence":
			return { ...state, presence: action.agents };
		case "rooms_loaded":
			return onRooms(state, action.rooms, action);
		case "layout_loaded":
			return {
				...state,
				pins: action.pins,
				hidden: action.hidden,
				folders: action.folders,
			};
		case "room_viewed":
			return withRoom(state, action.view.key, (room) => ({
				...room,
				view: action.view,
				mode: action.view.mode,
			}));
		case "threads_dismissed":
			return {
				...state,
				order: state.order.filter((key) => !action.rooms.includes(key)),
			};
		case "room_muted": {
			const held = state.rooms[action.room]?.view;
			if (!held || (held.muted === true) === action.muted) return state;
			const { muted: _muted, ...rest } = held;
			return withRoom(state, action.room, (room) => ({
				...room,
				view: action.muted ? { ...rest, muted: true } : rest,
			}));
		}
		case "history_loaded":
			return resolvedPruned(
				withClosedCards(
					fromStart(onHistory(state, action), action.room),
					action.room,
					action.cards ?? [],
				),
			);
		case "focused": {
			const left = state.focus;
			const rooms = { ...state.rooms };
			// What the page stops showing goes back to its latest page.
			if (left && left !== action.room && rooms[left])
				rooms[left] = trimmed(rooms[left] as RoomState);
			// What the turn streamed before the page looked at the room is not shown.
			// A failure the person has now seen is over.
			if (action.room && rooms[action.room]) {
				const {
					outcome: _outcome,
					outcomeAt: _at,
					...kept
				} = rooms[action.room] as RoomState;
				rooms[action.room] = { ...kept, progress: NO_PROGRESS };
			}
			return resolvedPruned({ ...state, focus: action.room, rooms });
		}
		case "queued":
			return withRoom(state, action.room, (room) => ({
				...room,
				pending: [
					...room.pending.filter((one) => one.id !== action.id),
					{
						id: action.id,
						room: action.room,
						text: action.text,
						files: action.files,
						...(action.mode ? { mode: action.mode } : {}),
					},
				],
			}));
		case "pending_dropped":
			return {
				...state,
				rooms: Object.fromEntries(
					Object.entries(state.rooms).map(([key, room]) => [
						key,
						{
							...room,
							pending: room.pending.filter((one) => one.id !== action.id),
						},
					]),
				),
			};
		case "refusal_dismissed":
			return { ...state, refusal: undefined };
		case "gate":
			return { ...state, gate: action.steps };
		// The host cards, the notices and the read marks are handled by the pages that show them; a refused block answer by the block that sent it.
		case "block_refused":
		case "host_card":
		case "room_changed":
		case "list_changed":
		case "page_changed":
		case "notice":
		case "notice_resolved":
		case "badge":
		case "read":
			return state;
	}
}
