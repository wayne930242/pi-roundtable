import type {
	ActivityPhase,
	CardAnswer,
	ClosedCard,
	FolderView,
	GateStepView,
	PromptFrame,
	PromptOutcome,
	RefusalCode,
	RoomFile,
	RoomMessage,
	RoomMode,
	RoomView,
	RoundView,
	ServerFrame,
	UploadView,
} from "../../src/api-types.ts";
import { isStartOver } from "../../src/api-types.ts";

// The owner app's state: a pure reducer over the socket's frames and the page's own actions, so
// what the page shows can be tested without a browser. Nothing here touches the DOM or the clock.

/** The most streamed text kept for a turn; older text scrolls out of the progress strip. */
const PROGRESS_TEXT_CHARS = 6000;
/** The most tool chips kept for a turn. */
const PROGRESS_TOOLS = 20;
/** The page of history fetched at a time, and the most a room the page does not show keeps. */
export const ROOM_PAGE = 50;
/** The most ended cards kept for a room whose messages the page holds none of; the history brings the rest. */
const KEPT_RESOLVED_CARDS = 30;

export interface ToolChip {
	id: string;
	tool: string;
	preview?: string;
	status: "running" | "ok" | "failed" | "refused";
	refused?: "declined" | "expired" | "pending" | "held" | "withdrawn";
}

/** What the running turn shows: the text it streams and the tools it runs. */
export interface Progress {
	text: string;
	tools: ToolChip[];
}

/** A message the person sent that the server has not accepted yet, or refused. */
export interface PendingSend {
	/** The page's own reference, which `accepted` and `refused` echo. */
	id: string;
	room: string;
	text: string;
	files: UploadView[];
	/** A host room's message: a note only records, a turn also goes to the host's claim. */
	mode?: "note" | "turn";
	failed?: RefusalCode;
}

/** A card of a room: open until `prompt_closed` ends it, then kept as a record. */
export interface CardState {
	room: string;
	frame: PromptFrame;
	/** The id of the room's newest stored message when it opened, which it stands after. */
	after: number;
	outcome?: PromptOutcome;
	note?: string;
	/** Who answered the card, by display name. */
	by?: string;
	/** What was answered, for the question cards. */
	answer?: CardAnswer;
	/** When it ended (ISO 8601, the server's clock). */
	closedAt?: string;
	/** How many answers to this card the server refused; a card offers its buttons again when it moves. */
	refused?: number;
}

export interface RoomState {
	key: string;
	/** From the room list; absent for a room only frames have mentioned so far. */
	view?: RoomView;
	/** Stored messages, oldest first. */
	messages: RoomMessage[];
	/** Interim messages of agents, shown until the final reply replaces them. */
	live: RoomMessage[];
	/** Older messages than the first one shown exist. */
	more: boolean;
	progress: Progress;
	typing: boolean;
	/** While typing: `working` during a tool call, `thinking` otherwise. */
	phase?: ActivityPhase;
	/** While typing: the member speaking, in a group round. */
	agent?: string;
	/** A group room: where its round stands, kept after it ends until the next round starts. */
	round?: RoundView;
	/** How the last turn ended, until the next turn starts or the page opens the room. */
	outcome?: "done" | "failed";
	/** When the page saw the outcome (its clock, epoch ms). */
	outcomeAt?: number;
	/** When the page last saw an activity frame of the room (epoch ms). */
	activityAt?: number;
	stoppable: boolean;
	mode: RoomMode;
	/** Yolo approvals seen in this room since the page opened. */
	autoApproved: number;
	pending: PendingSend[];
}

export interface RoomsState {
	connection: "connecting" | "open" | "reconnecting" | "closed";
	principal?: { id: string; name: string };
	limits?: { perMessage: number; maxBytes: number };
	rooms: Record<string, RoomState>;
	/** The room keys as the server listed them: Home first. */
	order: string[];
	/** The owners' pinned rooms, in their order; shared by every device. */
	pins: string[];
	/** The owners' folders and what is in them, in their order. */
	folders: FolderView[];
	/** Which agents work now, anywhere, as the last `presence` frame said. */
	presence: Record<string, { busy: boolean }>;
	/** Whether the list was fetched at least once. */
	listed: boolean;
	cards: Record<string, CardState>;
	/** Card ids in the order they opened. */
	cardOrder: string[];
	/** The room the page shows, whose progress streams to it. */
	focus: string | undefined;
	/** Counts `changed` frames: the room list is fetched again when it moves. */
	revision: number;
	/** Counts `ready` frames: a room's latest page is fetched again when it moves. */
	connects: number;
	/** The last refusal that belongs to no send, to be shown once. */
	refusal: RefusalCode | undefined;
	/** The socket was closed because the person is no longer admitted. */
	forbidden: boolean;
	/** The required steps the server says the person owes now; undefined until the socket says. */
	gate: GateStepView[] | undefined;
}

/** What the page does itself, beside the server's frames. */
export type LocalAction =
	| { type: "connection"; status: RoomsState["connection"] }
	| { type: "forbidden" }
	| {
			type: "rooms_loaded";
			rooms: RoomView[];
			/** The shared arrangement; absent keeps the one held. */
			pins?: string[];
			folders?: FolderView[];
	  }
	/** The arrangement of the list changed: the page's own edit, optimistic, or the server's answer. */
	| { type: "layout_loaded"; pins: string[]; folders: FolderView[] }
	/** The server took a room's mute or unmute. */
	| { type: "room_muted"; room: string; muted: boolean }
	/** A room the list does not carry (a dismissed thread) opened by its address. */
	| { type: "room_viewed"; view: RoomView }
	/** Finished threads the owners took off the list. */
	| { type: "threads_dismissed"; rooms: string[] }
	| {
			type: "history_loaded";
			room: string;
			messages: RoomMessage[];
			more: boolean;
			/** A page of older messages, to go before the ones shown. */
			older: boolean;
			/** The cards of the room that ended within the page's span, which stand among its messages. */
			cards?: ClosedCard[];
	  }
	| { type: "focused"; room: string | undefined }
	| {
			type: "queued";
			id: string;
			room: string;
			text: string;
			files: UploadView[];
			mode?: "note" | "turn";
	  }
	| { type: "pending_dropped"; id: string }
	| { type: "refusal_dismissed" };

/** An `activity` frame stamped with the page's clock (epoch ms), which the reducer has none of. */
export type ActivityFrame = Extract<ServerFrame, { type: "activity" }> & {
	at?: number;
};

export type Action =
	| Exclude<ServerFrame, { type: "activity" }>
	| ActivityFrame
	| LocalAction;

const NO_MODE: RoomMode = { yolo: false, longRunning: false };
const NO_PROGRESS: Progress = { text: "", tools: [] };

export function initialState(): RoomsState {
	return {
		connection: "connecting",
		rooms: {},
		order: [],
		pins: [],
		folders: [],
		presence: {},
		listed: false,
		cards: {},
		cardOrder: [],
		focus: undefined,
		revision: 0,
		connects: 0,
		refusal: undefined,
		forbidden: false,
		gate: undefined,
	};
}

const blank = (key: string): RoomState => ({
	key,
	messages: [],
	live: [],
	more: false,
	progress: NO_PROGRESS,
	typing: false,
	stoppable: false,
	mode: NO_MODE,
	autoApproved: 0,
	pending: [],
});

/** The state with one room changed; the room is made if it is new. */
function withRoom(
	state: RoomsState,
	key: string,
	change: (room: RoomState) => RoomState,
): RoomsState {
	const room = state.rooms[key] ?? blank(key);
	return { ...state, rooms: { ...state.rooms, [key]: change(room) } };
}

/** `messages` with `incoming` added in id order, once each. */
function merged(
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
function trimmed(room: RoomState): RoomState {
	if (room.messages.length <= ROOM_PAGE) return room;
	return { ...room, messages: room.messages.slice(-ROOM_PAGE), more: true };
}

/**
 * The state without the ended cards the page need not hold: those of a room whose older messages
 * it left out and that opened before the first one it keeps (the history brings them back with
 * those messages), and all but the newest few of a room it holds no message of.
 */
function resolvedPruned(state: RoomsState): RoomsState {
	const drop = new Set<string>();
	const without = new Map<string, string[]>();
	for (const id of state.cardOrder) {
		const card = state.cards[id];
		if (!card?.outcome) continue;
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
function withClosedCards(
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

function onProgress(
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

function onMessage(
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
		const replies = message.kind === "agent";
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
function fromStart(state: RoomsState, key: string): RoomsState {
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

function onHistory(
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
function withTurn(
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

function onRooms(
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
				mode: { yolo: action.yolo, longRunning: action.longRunning },
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
			return { ...state, pins: action.pins, folders: action.folders };
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
		// The host cards, the notices and the read marks are handled by the pages that show them.
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
function opensBefore(card: CardState, message: RoomMessage): boolean {
	const opened = Date.parse(card.frame.at ?? "");
	const stored = Date.parse(message.at);
	if (!Number.isNaN(opened) && !Number.isNaN(stored)) return opened < stored;
	return card.after < message.id;
}

export type TimelineItem =
	| { kind: "message"; message: RoomMessage }
	| { kind: "card"; card: CardState; id: string }
	| { kind: "pending"; pending: PendingSend }
	| { kind: "live"; message: RoomMessage };

/** What the room shows top to bottom: stored messages with cards in place, then what is on its way. */
export function timeline(
	state: Pick<RoomsState, "rooms" | "cards" | "cardOrder">,
	key: string,
): TimelineItem[] {
	const room = state.rooms[key];
	if (!room) return [];
	const cards = state.cardOrder
		.map((id) => ({ id, card: state.cards[id] }))
		.filter(
			(entry): entry is { id: string; card: CardState } =>
				entry.card?.room === key,
		);
	const items: TimelineItem[] = [];
	let placed = 0;
	/** Cards that opened before `next` (or all, at the end) stand here. */
	const cardsBefore = (next: RoomMessage | undefined) => {
		while (placed < cards.length) {
			const entry = cards[placed];
			if (!entry || (next && !opensBefore(entry.card, next))) break;
			items.push({ kind: "card", card: entry.card, id: entry.id });
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
	for (const pending of room.pending) items.push({ kind: "pending", pending });
	for (const message of room.live) items.push({ kind: "live", message });
	return items;
}

/** A file's address under the mount, for a link or an image. */
export const fileUrl = (file: Pick<RoomFile, "id">): string =>
	`api/files/${encodeURIComponent(file.id)}`;
