import type { CharacterSpec } from "pi-roundtable/characters";
import type { ActivityPhase } from "./api-common-types.ts";
import type { RoomBlockAnswer } from "./block-answer-types.ts";
import type {
	HostAuthorKind,
	PictureRef,
	RoomIntercom,
} from "./message-types.ts";
import type { ClosedCard } from "./prompt-types.ts";

// ── The owner app: rooms, messages, and cards ───────────────────────────────

/** The WebSocket subprotocol of `<mount>/api/socket`; a later incompatible version gets a new name. */
export const APP_PROTOCOL = "roundtable.app.v1";

/** The version `ready` reports. */
export const APP_PROTOCOL_VERSION = 1;

/** The close code that says the credential lapsed: reconnect, and reload the page when the reconnect is refused. */
export const APP_CLOSE_EXPIRED = 4401;

/** The close code that says the person is no owner (any more): do not reconnect. */
export const APP_CLOSE_FORBIDDEN = 4403;

/** The most bytes (UTF-8, as JSON) an approval frame's `approval` carries before its long values are cut: 256 KiB. */
export const APPROVAL_MAX_BYTES = 256 * 1024;

/** The most files one message carries. */
export const MAX_MESSAGE_FILES = 4;

/** The longest message text in characters. */
export const MAX_MESSAGE_CHARS = 32_000;

/** What a room is: an agent's, a group's, or a dispatch thread (read only). */
export type RoomKind = "agent" | "group" | "thread";

/** The conversation's modes, per room. */
export interface RoomMode {
	yolo: boolean;
	longRunning: boolean;
	/** The modes follow another conversation's, named here: a temp knight's follow its parent's, and cannot be switched in its own room. */
	inheritedFrom?: string;
}

/** A file in a message, served at `<mount>/api/files/<id>`. */
export interface RoomFile {
	id: string;
	name: string;
	type: string;
	size: number;
}

/**
 * The line a conversation's start-over writes into its room. The room shows what came from its
 * latest such line on; what is older belongs to the archived conversation, read on request.
 */
export const START_OVER_TEXT = "Conversation started over";

/** Whether a message is the line a start-over wrote. */
export const isStartOver = (message: Pick<RoomMessage, "kind" | "text">) =>
	message.kind === "system" && message.text === START_OVER_TEXT;

/**
 * One message of a room. `id` is the room log's own number, ascending; a live message (an
 * agent's interim text, shown until its final reply arrives) has `id` 0 and a `live` token,
 * and a later frame with the same token replaces it. It is never stored: the client drops a
 * room's live messages when a stored message of that agent arrives or the agent stops working.
 */
export interface RoomMessage {
	id: number;
	room: string;
	/** `owner` wrote it, `agent` is a reply, `system` a line the server wrote, `integration` a webhook's post. */
	kind: "owner" | "agent" | "system" | "integration";
	/** The principal of an `owner` message. */
	principalId?: string;
	/** The agent name of an `agent` message. */
	agent?: string;
	/** The name to show with it. */
	author: string;
	text: string;
	files: RoomFile[];
	/** ISO time. */
	at: string;
	live?: string;
	/**
	 * Host rooms: what kind of author wrote it (`external` text is untrusted and shown as plain
	 * text) and the label the host gives that kind, such as "Customer". Absent on the app's own.
	 */
	authorKind?: HostAuthorKind;
	authorLabel?: string;
	/** Host rooms: the author's picture, never an outside URL. */
	picture?: PictureRef;
	/** The text was changed after it was stored. */
	edited?: true;
	/** An internal note for the humans who read the room, never handed to the agent: an `owner` message of a room with `notes`. */
	note?: true;
	/** Files of the message that were deleted by retention. */
	expiredFiles?: number;
	/** A message between two agents, drawn as a small card that opens to `text`: the whole request or answer, or why none came. */
	intercom?: RoomIntercom;
	/**
	 * An `owner` message sent while a turn ran: `steered` was added to that turn, `queued` waits for
	 * its own (it can be edited or cancelled until the turn starts, and goes away when it does),
	 * `cancelled` was cancelled while it waited and never runs. Absent on an ordinary message.
	 */
	delivery?: "steered" | "queued" | "cancelled";
	/** An `agent` message: the interactive blocks the owner has answered, which the page shows locked with what was sent. */
	answers?: RoomBlockAnswer[];
	/** An `owner` message: it carries the answer to a block, so it cannot be edited while it waits; cancelling it opens the block again. */
	answer?: true;
}

/** A button a host card or header offers, and the form it opens first. */
export interface HostActionView {
	id: string;
	label: string;
	style?: "primary" | "secondary" | "danger";
	confirm?: string;
	form?: FormSpecView;
}

export interface FormSpecView {
	title: string;
	submit: string;
	fields: FormFieldView[];
}

export type FormFieldView =
	| {
			name: string;
			label: string;
			type: "text" | "textarea" | "url";
			required?: boolean;
			max?: number;
			initial?: string;
			hint?: string;
	  }
	| {
			name: string;
			label: string;
			type: "select" | "multiselect";
			required?: boolean;
			options: { value: string; label: string }[];
			/** The value or values chosen when the form opens; a `select` takes one. */
			initial?: string | readonly string[];
			/** The page offers a filter box over the options, for a long list. */
			search?: boolean;
	  };

/** A card a host puts in its room; its buttons call the host's `act`. */
export interface HostCardView {
	id: string;
	room: string;
	title: string;
	body: string;
	tone?: "note" | "ok" | "warn" | "risk";
	state?: "open" | "working" | "done" | "superseded" | "expired";
	links?: { label: string; url: string }[];
	/** Only the buttons this viewer may press. */
	buttons?: HostActionView[];
	/** ISO times. */
	at: string;
	updatedAt: string;
}

/** A person-addressed notice, as the bell shows it. */
export interface NoticeView {
	tag: string;
	title: string;
	body?: string;
	open?:
		| { room: string; message?: number }
		| { page: string; query?: Record<string, string> };
	urgency: "normal" | "high";
	ackable: boolean;
	/** ISO time. */
	raisedAt: string;
	/** This person has handled it. */
	acked?: true;
}

/** One entry of the room list. */
export interface RoomView {
	/** The channel key: `<surface>:agent.<name>`, `<surface>:group.<name>` or `<surface>:thread.<id>`. */
	key: string;
	kind: RoomKind;
	/** The agent's or group's name; a thread's id. */
	name: string;
	displayName: string;
	/** The room where the page opens: the coordinator's, else the first active agent's. */
	home: boolean;
	/** The coordinator's room: the team's entry, which cannot be archived. */
	coordinator?: true;
	/** The agent's picture, a path under the mount, for notification icons; absent for groups and threads. */
	avatar?: string;
	/** An agent room's character; a group page looks its members' up in the agent rooms. */
	character?: CharacterSpec;
	/** A group's members, by agent name. */
	members?: string[];
	/** A thread's parent room. */
	parent?: string;
	/**
	 * A temp knight's room: `parent` is the room of the knight that made it, `origin` the room it was
	 * made from (a group's, when the knight made it during the group's round; absent when that is no
	 * room of this app), `finished` is set when it has nothing running, queued or waiting, and
	 * `preset` names the preset it was made from. Absent on every permanent knight.
	 */
	helper?: {
		parent: string;
		parentName: string;
		origin?: string;
		finished?: true;
		preset?: string;
	};
	/** A thread's room takes no messages from the page. */
	readOnly: boolean;
	/**
	 * More than one person reads this agent or group room, so the composer offers `@AI` off: a
	 * message sent with `mode: "note"` is kept for them and not given to the agent. Absent in a
	 * room only one person reads.
	 */
	notes?: true;
	/** A thread whose dispatch has ended; its room stays readable. */
	closed?: boolean;
	mode: RoomMode;
	/** The owners muted this room's push: its posts and notices are not pushed; a card still is. */
	muted?: true;
	/** The room's agent is working now. */
	typing: boolean;
	/** While typing: `working` during a tool call, `thinking` otherwise. */
	phase?: ActivityPhase;
	/** While typing: the member speaking, in a group round. */
	agent?: string;
	/** A turn runs that Stop would end. */
	stoppable: boolean;
	/** A group room: the round running now, who has spoken and who is next; absent when none runs. */
	round?: RoundView;
	/** The newest stored message, if any. */
	last?: RoomMessage;
	/** Messages past this person's read cursor; absent when none. */
	unread?: number;
}

/** Where one person has read a room up to, with the name the page shows for them. */
export interface ReadMarkView {
	principal: string;
	name: string;
	/** The id of the newest message they have read. */
	upTo: number;
	/** ISO time. */
	at: string;
}

/** An owner-made folder of rooms, with its rooms in the owner's order. */
export interface FolderView {
	/** `folder.<uuid>`. */
	id: string;
	name: string;
	/** Room keys in order. */
	rooms: string[];
}

/**
 * The owners' shared arrangement of the room list: pinned rooms in their order, then the folders
 * in theirs. A room is pinned, in one folder, or in neither; the rest are listed by latest activity.
 */
export interface LayoutView {
	/** The pinned rooms' keys, in order. */
	pins: string[];
	folders: FolderView[];
}

/** `GET api/rooms/<key>` for a thread: its view, listed or dismissed from the list. */
export interface RoomOneView {
	room: RoomView;
}

/**
 * One thing the owner may run by typing `/` in a room's message box besides the page's own `/clear`:
 * a skill the agent carries (`name` is `skill:<skill>`) or an extension command a plugin declared.
 * The page sends it as a normal message, `/<name> <arguments>`.
 */
export interface RoomCommandView {
	name: string;
	/** One line for the menu. */
	description: string;
	source: "skill" | "extension";
}

/** `GET api/rooms/<room>/commands`: the room's commands; none for a group, a thread and a room that is read only. */
export interface RoomCommandsView {
	commands: RoomCommandView[];
}

/** What a dismissal removed from the room list: the finished threads that were listed. */
export interface ThreadsDismissed {
	dismissed: number;
}

/** What one clear-all across rooms dismissed: the finished threads' room keys, by the room they hang under. */
export interface ThreadsDismissedAll extends ThreadsDismissed {
	threads: Record<string, string[]>;
}

/**
 * What a system line of a room starts with when its knight cleared its temp knights: the rest is a
 * JSON list of `{ name, displayName }`, which the page words and offers the undo of.
 */
export const HELPERS_ENDED = "Temp knights archived: ";

/** `POST api/rooms/archive-finished-helpers`: the temp knights archived, by the room of the knight that made them. */
export interface HelpersArchived {
	archived: { room: string; names: string[] }[];
}

/** `POST api/rooms/restore-helpers`: the temp knights that came back; a name no longer archived is passed over. */
export interface HelpersRestored {
	restored: string[];
}

/** A cursor that marking rooms read moved: where it was (0 for a room never read) and where it is. */
export interface ReadMove {
	room: string;
	from: number;
	to: number;
}

/** What marking rooms read moved; the page keeps it to undo the marking. */
export interface ReadAllView {
	moved: ReadMove[];
}

/** What undoing a marking put back: the rooms whose cursor went back. */
export interface ReadAllUndone {
	restored: string[];
}

/** What taking dismissed threads back onto the room list restored. */
export interface ThreadsRestored {
	restored: number;
}

export interface RoomsView extends LayoutView {
	rooms: RoomView[];
}

/** A page of a room's stored messages, oldest first, and the cards that ended among them. */
export interface MessagesView {
	messages: RoomMessage[];
	/** There are older messages than the first one here. */
	more: boolean;
	/**
	 * The cards of the room that opened within this page's span (from the first message's time,
	 * or from the beginning when `more` is false, up to the next page's first message), oldest
	 * first; the page places each among the messages by `frame.at`.
	 */
	cards: ClosedCard[];
	/** The other readers' cursors: how far each has read the room (the viewer's own is `cursor`). */
	reads?: ReadMarkView[];
	/** The viewer's own read cursor before they opened the room; absent when they never read it. */
	cursor?: number;
}

/**
 * Where a group's round stands: the members' answers to one owner message, one after another.
 * `id` is the group message that opened the round, so a new round is told from the last one.
 */
export interface RoundView {
	id: number;
	state: "running" | "ended";
	/** The member speaking now, by name. */
	current?: string;
	/** The members still to speak, in order, a handoff appended. */
	next: string[];
	/** The members who have replied so far, in order. */
	spoken: string[];
	/** The replies made so far, and the most a round holds. */
	replies: number;
	limit: number;
	/** Why the round ended: every member spoke, it reached its limit, or the owner stopped it. */
	ended?: "done" | "limit" | "stopped";
	/** The owner's messages waiting in the room for the next round. */
	queued?: number;
}
