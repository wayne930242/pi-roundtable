// The console's API shapes, shared by the server (`src/`) and the page (`web/`). Times are ISO strings.

/** The panes the console can show; the options choose which ones a host serves. */
export const PANES = [
	"overview",
	"conversations",
	"notes",
	"skills",
	"connectors",
	"rooms",
	"schedules",
] as const;
export type PaneName = (typeof PANES)[number];

/** What the page needs before it can draw anything. */
export interface ConfigView {
	title: string;
	panes: PaneName[];
	/** The IANA zone the page formats times and event dates in: the host's `env.timeZone`. */
	timeZone: string;
	locale?: string;
	messages?: Readonly<Record<string, string>>;
	cleanup?: boolean;
	connectorAdminUrl?: string;
	/** Only supplied for path-based routing; also the base for page/API URLs. */
	mountPath?: string;
	/** Present when the `rooms` pane is served: how the page opens the owner app's socket. */
	app?: {
		/** The key prefix of the app's rooms, such as `app`. */
		surface: string;
		/** The WebSocket subprotocol to offer. */
		protocol: string;
	};
}

export type ChannelName =
	| { kind: "dm"; name: string }
	| { kind: "guild"; name: string; guild: string; guildId: string }
	/** Discord no longer knows the channel. */
	| { kind: "gone" }
	/** Discord could not be asked, or the host has no Discord connection. */
	| { kind: "unknown" };

export interface ContextView {
	tokens: number | null;
	contextWindow: number;
}

export interface AgentView {
	name: string;
	displayName: string;
	channelId?: string;
	model: string;
	thinking: string;
	/** Channel id of its running turn. */
	workingIn?: string;
	waiting: number;
	context?: ContextView;
	lastActive?: string;
	schedules: number;
}

export interface GroupView {
	name: string;
	displayName: string;
	/** The group's Discord channel; a team without Discord has none. */
	channelId?: string;
	members: string[];
	host: string;
	busy: number;
	lastActive?: string;
}

export interface OverviewView {
	guildId: string;
	agents: AgentView[];
	groups: GroupView[];
	workspaces?: (ConversationView & { schedules: number })[];
	outside?: ConversationView[];
	party?: PartyView[];
}

/** Compatibility dashboard shape for hosts migrating an existing console endpoint. */
export interface DashboardView {
	agentGuildId: string;
	agents: (AgentView & { key: string })[];
	groups: (GroupView & { key: string })[];
	workspaces: (ConversationView & { channelId: string; schedules: number })[];
	outside: (ConversationView & { sessionId: string })[];
	party: PartyView[];
}

/**
 * Where a stored conversation came from, for the page to group it by; it grants nothing. `owner`
 * is a Discord channel no agent or group owns, where an owner talks to the assistant; `plugin` is
 * one a plugin runs through `context.turns`, such as a web chat, as the host's registry records
 * it. Whose a conversation is, the registry says: `ConversationView.principal`.
 */
export type ConversationKind =
	| "agent"
	| "group"
	| "owner"
	| "outside"
	| "plugin";

export interface ConversationView {
	/** The channel key: `discord:<id>`, `agentgroup:<channel>.<agent>`, or `mcp:<session>`. */
	key: string;
	kind: ConversationKind;
	/** The Discord channel id, or the outside agent's session id. */
	id: string;
	/** Group conversations only: the agent whose conversation inside the group this is. */
	member?: string;
	/** Discord conversations, group ones included. */
	channel?: ChannelName;
	/** Bytes of the live conversation; 0 when only archives are left. */
	liveBytes: number;
	archives: number;
	lastActive?: string;
	/** Outside-agent and plugin conversations only: up to 80 characters of the first message. */
	firstMessage?: string;
	startedAt?: string;
	/** Plugin conversations only: the name the registry gives it. */
	title?: string;
	/** Conversations the host's registry records: `private` to one principal, or `shared`. */
	visibility?: "private" | "shared";
	/** Conversations the registry records as someone's: whose, by their principal's name. */
	principal?: PrincipalName;
	/** Turns running or waiting in the channel. */
	busy: number;
}

/** A principal as the console names them. */
export interface PrincipalName {
	id: string;
	/** Their display name, or their id when the host no longer knows them. */
	name: string;
}

export interface ConversationsView {
	conversations: ConversationView[];
}

export type TranscriptRole = "user" | "assistant" | "tool" | "compaction";

export interface TranscriptEntry {
	role: TranscriptRole;
	at?: string;
	text: string;
	/** What an assistant message called, by name with a short preview of the arguments. */
	calls?: { name: string; preview: string }[];
	/** The tool a `tool` entry answers. */
	tool?: string;
	failed?: boolean;
}

export interface TranscriptView {
	conversation: ConversationView;
	/** The names of the conversation's archives, newest first. */
	archives: string[];
	/** The archive being read; absent for the live conversation. */
	archive?: string;
	entries: TranscriptEntry[];
	/** True when the file was longer than the console reads, so the oldest entries are missing. */
	truncated: boolean;
}

export type NoteKind = "core" | "note" | "event";

export interface NoteView {
	id: number;
	kind: NoteKind;
	fact: string;
	eventDate: string | null;
}

/** The people whose notes the notes pane can show: the visitor first, then the others, oldest first. */
export interface PrincipalsView {
	/** The visitor's own principal, whose notes the pane shows unless asked for another's. */
	self: string;
	principals: (PrincipalName & { disabled?: true })[];
}

export interface NoteInput {
	fact: string;
	kind: NoteKind;
	eventDate?: string;
}

export interface PartyView {
	key: string;
	channelId: string;
	channel: ChannelName;
	profile: string;
	enabledBy: string;
	enabledAt: string;
	container: "missing" | "running" | "stopped" | "unknown";
	busy: number;
	lastActive?: string;
}

export interface SkillView {
	name: string;
	source:
		| { kind: "builtin" }
		| { kind: "linked"; repo: string; path: string }
		| { kind: "written" }
		| { kind: "package"; package: string };
	description?: string;
	missing?: string;
	groups: string[];
	carriers: string[];
}

export interface SkillDetailView {
	name: string;
	metadata: { key: string; value: string }[];
	body: string;
}

export interface ConnectorsView {
	gateways: {
		name: string;
		enabled: boolean;
		reachable: boolean;
		tools: number;
	}[];
	servers: { name: string; tools: string[]; usedBy: string[] }[];
}

/** Every error body the API returns. */
export interface ApiError {
	error: string;
}

// ── The owner app: rooms, messages, cards, and the socket's frames ───────────────────────────────

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
}

/** A file in a message, served at `<mount>/api/files/<id>`. */
export interface RoomFile {
	id: string;
	name: string;
	type: string;
	size: number;
}

/**
 * One message of a room. `id` is the room log's own number, ascending; a live message (an
 * agent's interim text, shown until its final reply arrives) has `id` 0 and a `live` token,
 * and a later frame with the same token replaces it. It is never stored: the client drops a
 * room's live messages when a stored message of that agent arrives or the agent stops working.
 */
export interface RoomMessage {
	id: number;
	room: string;
	/** `owner` wrote it, `agent` is a reply, `system` is a line the server wrote: a divider, a yolo approval. */
	kind: "owner" | "agent" | "system";
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
}

/** One entry of the room list. */
export interface RoomView {
	/** The channel key: `<surface>:agent.<name>`, `<surface>:group.<name>` or `<surface>:thread.<id>`. */
	key: string;
	kind: RoomKind;
	/** The agent's or group's name; a thread's id. */
	name: string;
	displayName: string;
	/** The coordinator's room, where the page opens. */
	home: boolean;
	/** The agent's picture, a path under the mount; absent for groups and threads. */
	avatar?: string;
	/** A group's members, by agent name. */
	members?: string[];
	/** A thread's parent room. */
	parent?: string;
	/** A thread's room takes no messages from the page. */
	readOnly: boolean;
	mode: RoomMode;
	/** The room's agent is working now. */
	typing: boolean;
	/** A turn runs that Stop would end. */
	stoppable: boolean;
	/** The newest stored message, if any. */
	last?: RoomMessage;
}

export interface RoomsView {
	rooms: RoomView[];
}

/** A page of a room's stored messages, oldest first. */
export interface MessagesView {
	messages: RoomMessage[];
	/** There are older messages than the first one here. */
	more: boolean;
}

/** Who the page is signed in as. */
export interface SessionView {
	principal: PrincipalName;
	surface: string;
	/** When the credential lapses, if it does. */
	expiresAt?: string;
}

/** A schedule, labelled by the room it belongs to or else its channel. */
export interface ScheduleView {
	id: number;
	/** The room it runs in, when it belongs to one of the app's. */
	room?: string;
	/** The channel key it runs in. */
	channel: string;
	/** What to call that place: the room's name or the channel key. */
	label: string;
	title: string;
	prompt: string;
	/** The schedule's recurrence as the core stores it. */
	recurrence: unknown;
	nextRun: string;
	lastRun?: string;
	lastStatus?: string;
	createdBy: string;
}

export interface SchedulesView {
	schedules: ScheduleView[];
}

/** An agent's profile as its page edits it. */
export interface AgentProfileView {
	name: string;
	displayName: string;
	prompt: string;
	/** Its own model; absent when it follows the assistant's. */
	model?: string;
	/** Its own thinking level; absent when it follows the assistant's. */
	thinking?: string;
	/** What its next turn runs on. */
	effective: { model: string; thinking: string };
	avatar: string;
	room: string;
	/** An image provider is set, so the picture can be drawn again. */
	canDraw: boolean;
}

export interface ModelsView {
	models: string[];
}

/** What changes an agent: the same fields `AgentTeam.update` takes. */
export interface AgentPatch {
	displayName?: string;
	prompt?: string;
	model?: string;
	thinking?: string;
}

/** The body of `POST api/agents/<name>/avatar`. */
export interface AvatarRequest {
	mode: string;
	text?: string;
}

/** A file waiting for the message that uses it. */
export interface UploadView {
	id: string;
	name: string;
	type: string;
	size: number;
}

/** An option of a question, as the core writes it. */
export interface PromptOption {
	label: string;
	description?: string;
	preview?: string;
}

/** One question of a card. */
export interface PromptQuestion {
	question: string;
	header?: string;
	/** None means a free-text answer. */
	options: readonly PromptOption[];
	multi: boolean;
	allowOther: boolean;
}

/** What a held call is, as data beside its markdown text. */
export interface PromptApproval {
	action: string;
	tool: string;
	input: Record<string, unknown>;
	files?: { path: string; bytes?: number }[];
	copy?: { label?: string; text: string };
	/** Set when long values of `input` were cut to fit `APPROVAL_MAX_BYTES`. */
	truncated?: true;
}

/** The card's own words in place of an approval's. */
export interface PromptWording {
	approve: string;
	decline: string;
	footer: string;
	approved: string;
	declined: string;
}

/** An answer to a question: the chosen options' labels and the person's own text. */
export interface PromptAnswer {
	choices: string[];
	text?: string;
}

/** A card the server asks the owner: an approval, a question, or several questions. */
export type PromptFrame =
	| {
			id: string;
			kind: "approval";
			title: string;
			/** The card as markdown text. */
			message: string;
			approval?: PromptApproval;
			/** `turn-timeout` is a turn's time-limit card: continuing it lets the turn go on. */
			purpose: "action" | "turn-timeout";
			wording?: PromptWording;
			/** Only the speaker whose turn asks may answer. */
			speakerOnly?: true;
			/** Display names of the people the call names to approve it; owners may still. */
			approvers?: string[];
			/** The turn stopped waiting; an answer starts a new turn in the room. */
			late?: true;
	  }
	| {
			id: string;
			kind: "ask";
			title: string;
			question: string;
			options: readonly PromptOption[];
			multi: boolean;
			allowOther: boolean;
			late?: true;
	  }
	| {
			id: string;
			kind: "questionnaire";
			title: string;
			questions: readonly PromptQuestion[];
			late?: true;
	  };

/** How a card ended. `withdrawn` is a card the plugin that asked for it took back. */
export type PromptOutcome =
	| "approved"
	| "declined"
	| "answered"
	| "expired"
	| "cancelled"
	| "withdrawn";

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
	| "not_accepted";

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
	  }
	| { type: "stop"; room: string }
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
			/** The most files one message carries and the most bytes of one. */
			uploads: { perMessage: number; maxBytes: number; types: string[] };
	  }
	/** The message `id` was taken into `room`; `message` is how it was stored. */
	| { type: "accepted"; id: string; room: string; message: RoomMessage }
	| { type: "refused"; id?: string; code: RefusalCode }
	/** A message of a room, stored or live; see `RoomMessage`. */
	| { type: "message"; room: string; message: RoomMessage }
	/** What the running turn writes and which tools it runs; sent to the sockets that focus the room. */
	| { type: "progress"; room: string; event: AppProgress }
	/** The room's agent is, or is no longer, working, and whether Stop applies. */
	| { type: "activity"; room: string; typing: boolean; stoppable: boolean }
	| { type: "prompt"; room: string; prompt: PromptFrame }
	| {
			type: "prompt_closed";
			prompt: string;
			outcome: PromptOutcome;
			/** Why a `withdrawn` card was taken back. */
			note?: string;
	  }
	| { type: "mode"; room: string; yolo: boolean; longRunning: boolean }
	/** Yolo mode approved a held call by itself. */
	| { type: "auto_approved"; room: string; tool: string; action: string }
	/** The team or the room list may differ: refetch. */
	| { type: "changed" };

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
