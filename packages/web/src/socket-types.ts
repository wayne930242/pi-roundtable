import type { CharacterSpec } from "pi-roundtable/characters";
import type { ActivityPhase, GateStepView } from "./api-common-types.ts";
import type {
	BlockAnswerBody,
	BlockFields,
	BlockRefusalCode,
} from "./block-answer-types.ts";
import type {
	CardAnswer,
	PromptAnswer,
	PromptFrame,
	PromptOutcome,
} from "./prompt-types.ts";
import type {
	APP_PROTOCOL_VERSION,
	HostCardView,
	NoticeView,
	RoomMessage,
	RoomMode,
	RoundView,
} from "./room-types.ts";

/** Why the server refused a frame. */
export type RefusalCode =
	| "bad_frame"
	| "unknown_room"
	| "read_only"
	| "forbidden"
	| "unknown_prompt"
	| "unknown_upload"
	| "empty"
	| "too_long"
	| "not_accepted"
	/** A queued message was cancelled or edited too late: its turn has started, or it was never queued. */
	| "not_queued"
	/** A queued message that carries the answer to a block cannot be edited, as its block would keep the old pick; cancel it instead. */
	| "answer_locked"
	/** A required onboarding step stands undone, so the frame is not taken yet. */
	| "gated";

/** The values of a form a host action opened. */
export type FormInput = Readonly<Record<string, string | readonly string[]>>;

/** What the page sends: one JSON object per WebSocket text message. */
export type ClientFrame =
	/** Declares whether the page is in view and which room it shows. Sent after each `ready`. */
	| { type: "hello"; visible: boolean; focus?: string }
	| { type: "visibility"; visible: boolean }
	/** The room the page shows now, or none: progress streams only for it. */
	| { type: "focus"; room?: string }
	| {
			type: "send";
			/** The page's own reference, echoed by `accepted` or `refused`. */
			id: string;
			room: string;
			text: string;
			/** Files uploaded with `POST api/uploads`, by the `id` each returned. */
			uploads?: string[];
			/** Host rooms: a `note` only records, a `turn` is also delivered to the host's claim. Default `turn`. An agent or group room takes a `note` only where its view has `notes`. */
			mode?: "note" | "turn";
	  }
	| { type: "stop"; room: string }
	/** Answers an interactive block of an agent's reply: the server sends the answer to the agent as the owner's next message, once. `accepted` or `block_refused` echoes `id`. */
	| {
			type: "block_answer";
			id: string;
			room: string;
			message: number;
			block: number;
			answer: BlockAnswerBody;
	  }
	/** Replaces the text of a message of yours that waits for its turn (`delivery: "queued"`). */
	| { type: "edit_queued"; room: string; message: number; text: string }
	/** Cancels a message of yours that waits for its turn (`delivery: "queued"`). */
	| { type: "cancel_queued"; room: string; message: number }
	/** Host rooms: follow a room's frames. At most 200 at once; the viewer must be able to read it. */
	| { type: "subscribe"; room: string }
	| { type: "unsubscribe"; room: string }
	/** A host room's or page's action: a card's button, a header action, a form. */
	| {
			type: "act";
			id: string;
			room?: string;
			page?: string;
			action: string;
			card?: string;
			input?: FormInput;
	  }
	/** The person handled a notice. */
	| { type: "ack"; tag: string }
	/** The person has read a room up to this message (a cursor never moves back). */
	| { type: "read"; room: string; upTo: number }
	| { type: "approval"; prompt: string; approved: boolean }
	| { type: "answer"; prompt: string; answer: PromptAnswer }
	| {
			type: "answers";
			prompt: string;
			answers: (PromptAnswer | null)[];
			note?: string;
	  }
	/** Cancels a question card instead of answering it. */
	| { type: "cancel"; prompt: string };

/** What the server sends: one JSON object per WebSocket text message. */
export type ServerFrame =
	/** The socket is authenticated; sent first, and followed by every open card. */
	| {
			type: "ready";
			protocol: typeof APP_PROTOCOL_VERSION;
			principal: string;
			name: string;
			/** The knight the person made for themselves, when they made one. */
			character?: CharacterSpec;
			/** The most files one message carries and the most bytes of one. */
			uploads: { perMessage: number; maxBytes: number };
			/** The required steps the person still owes, when there are any: the socket then carries only the gate and their notices. */
			gate?: GateStepView[];
	  }
	/** The message `id` was taken into `room`; `message` is how it was stored. */
	| { type: "accepted"; id: string; room: string; message: RoomMessage }
	/** `id` names the refused `send`; `prompt` names the card whose answer was refused. */
	| { type: "refused"; id?: string; prompt?: string; code: RefusalCode }
	/** A `block_answer` was not taken; the block stays open unless `code` is `answered`, when `fields` are what answered it. */
	| {
			type: "block_refused";
			id: string;
			room: string;
			message: number;
			block: number;
			code: BlockRefusalCode;
			reason?: string;
			fields?: BlockFields;
	  }
	/** A message of a room, stored or live; see `RoomMessage`. */
	| { type: "message"; room: string; message: RoomMessage }
	/** A stored message changed its text in place, such as a thread's start line once the thread exists. */
	| { type: "edited"; room: string; message: RoomMessage }
	/** What the running turn writes and which tools it runs; sent to the sockets that focus the room. */
	| { type: "progress"; room: string; event: AppProgress }
	/** The room's agent is, or is no longer, working, and whether Stop applies. */
	| {
			type: "activity";
			room: string;
			typing: boolean;
			stoppable: boolean;
			phase?: ActivityPhase;
			/** The member speaking, in a group round. */
			agent?: string;
			/** Only on the frame where `typing` turns false. */
			outcome?: "done" | "failed";
	  }
	/** Where a group room's round stands; sent at each step and when it ends. */
	| { type: "round"; room: string; round: RoundView }
	/** Which agents work now, anywhere (Discord included); sent after `ready` and when it changes. */
	| { type: "presence"; agents: Record<string, { busy: boolean }> }
	| { type: "prompt"; room: string; prompt: PromptFrame }
	| {
			type: "prompt_closed";
			prompt: string;
			outcome: PromptOutcome;
			/** Why a `withdrawn` card was taken back. */
			note?: string;
			/** Who answered the card, by display name. */
			by?: string;
			/** What was answered, for the question cards. */
			answer?: CardAnswer;
			/** When it ended (ISO 8601, the server's clock). */
			closedAt?: string;
	  }
	| ({ type: "mode"; room: string } & RoomMode)
	/** Yolo mode approved a held call by itself. */
	| { type: "auto_approved"; room: string; tool: string; action: string }
	/** The team or the room list may differ: refetch. */
	| { type: "changed" }
	/** A host room's message, edit or removal, and its cards; sent to the sockets subscribed to the room. */
	| { type: "host_message"; room: string; message: RoomMessage }
	| { type: "host_edited"; room: string; message: RoomMessage }
	| { type: "host_removed"; room: string; id: number }
	| { type: "host_card"; room: string; card: HostCardView }
	/** A host room's header or access may differ: refetch it. */
	| { type: "room_changed"; room: string }
	/** The list of a kind of host room may differ: refetch it. */
	| { type: "list_changed"; kind: string }
	| { type: "page_changed"; page: string }
	| { type: "notice"; notice: NoticeView }
	| { type: "notice_resolved"; tag: string }
	/** The count the app icon shows: notices not handled. */
	| { type: "badge"; count: number }
	/** The steps still undone; empty when the gate opened. */
	| { type: "gate"; steps: GateStepView[] }
	/** Someone read a room up to a message; `name` and `at` let the page show them without asking. */
	| {
			type: "read";
			room: string;
			principal: string;
			name: string;
			upTo: number;
			/** ISO time. */
			at: string;
	  };

/** A turn's live view, as the core reports it. */
export type AppProgress =
	| { type: "text"; delta: string }
	| { type: "tool_start"; id: string; tool: string; preview?: string }
	| {
			type: "tool_end";
			id: string;
			tool: string;
			ok: boolean;
			refused?: "declined" | "expired" | "pending" | "held" | "withdrawn";
	  };
