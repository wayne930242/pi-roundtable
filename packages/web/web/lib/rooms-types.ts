import type { CharacterSpec } from "pi-roundtable/characters";
import type {
	ActivityPhase,
	CardAnswer,
	ClosedCard,
	FolderView,
	GateStepView,
	PromptFrame,
	PromptOutcome,
	RefusalCode,
	RoomMessage,
	RoomMode,
	RoomView,
	RoundView,
	ServerFrame,
	UploadView,
} from "../../src/api-types.ts";
import type { ToolChip } from "./tool-chip.ts";

// The owner app's state: a pure reducer over the socket's frames and the page's own actions, so
// what the page shows can be tested without a browser. Nothing here touches the DOM or the clock.

/** The most streamed text kept for a turn; older text scrolls out of the progress strip. */
export const PROGRESS_TEXT_CHARS = 6000;
/** The most tool chips kept for a turn. */
export const PROGRESS_TOOLS = 20;
/** The page of history fetched at a time, and the most a room the page does not show keeps. */
export const ROOM_PAGE = 50;
/** The most ended cards kept for a room whose messages the page holds none of; the history brings the rest. */
export const KEPT_RESOLVED_CARDS = 30;

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
	/** The person signed in, with the knight they made for themselves when they made one. */
	principal?: {
		id: string;
		name: string;
		character?: CharacterSpec | undefined;
	};
	limits?: { perMessage: number; maxBytes: number };
	rooms: Record<string, RoomState>;
	/** The room keys as the server listed them: Home first. */
	order: string[];
	/** The owners' pinned rooms, in their order; shared by every device. */
	pins: string[];
	/** The rooms the owners hid from the home, in the order they were hidden; shared by every device. */
	hidden: string[];
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
			hidden?: string[];
			folders?: FolderView[];
	  }
	/** The arrangement of the list changed: the page's own edit, optimistic, or the server's answer. */
	| {
			type: "layout_loaded";
			pins: string[];
			hidden: string[];
			folders: FolderView[];
	  }
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
	/** The person saved or removed their own knight in this tab. */
	| { type: "knight"; character: CharacterSpec | undefined }
	| { type: "refusal_dismissed" };

/** An `activity` frame stamped with the page's clock (epoch ms), which the reducer has none of. */
export type ActivityFrame = Extract<ServerFrame, { type: "activity" }> & {
	at?: number;
};

export type Action =
	| Exclude<ServerFrame, { type: "activity" }>
	| ActivityFrame
	| LocalAction;

export const NO_MODE: RoomMode = { yolo: false, longRunning: false };
export const NO_PROGRESS: Progress = { text: "", tools: [] };

export function initialState(): RoomsState {
	return {
		connection: "connecting",
		rooms: {},
		order: [],
		pins: [],
		hidden: [],
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

export const blank = (key: string): RoomState => ({
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
