// The console's API shapes, shared by the server (`src/`) and the page (`web/`). Times are ISO strings.

import type { CharacterInput, CharacterSpec } from "pi-roundtable/characters";

/** What an agent is doing in a room, while it works. */
export type ActivityPhase = "thinking" | "working";

/** The panes the console can show; the options choose which ones a host serves. */
export const PANES = [
	"overview",
	"conversations",
	"notes",
	"skills",
	"connectors",
	"rooms",
	"schedules",
	"table",
	"workspace",
] as const;
export type PaneName = (typeof PANES)[number];

/** What the page needs before it can draw anything. */
export interface ConfigView {
	title: string;
	panes: PaneName[];
	/** The IANA zone the page formats times and event dates in: the host's `env.timeZone`. */
	timeZone: string;
	/** The page's look unless the owner picked one in the app; the server always sends it. */
	look?: "modern" | "camelot";
	/** The six `#rrggbb` skin tones every character is drawn with, which a look's `skin` index picks from: the host's `characters.skins`, the kit's own by default. */
	characterSkins?: readonly string[];
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
	/** The agent's picture, a path under the mount, for notification icons; absent for groups and threads. */
	avatar?: string;
	/** An agent room's character; a group page looks its members' up in the agent rooms. */
	character?: CharacterSpec;
	/** A group's members, by agent name. */
	members?: string[];
	/** A thread's parent room. */
	parent?: string;
	/** A thread's room takes no messages from the page. */
	readOnly: boolean;
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
	/** The newest stored message, if any. */
	last?: RoomMessage;
}

export interface RoomsView {
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
}

/** Who the page is signed in as. */
export interface SessionView {
	principal: PrincipalName;
	surface: string;
	/** How the console signs the person in; the page offers Log out under `password`. */
	auth: "none" | "password" | "verifier";
	/** When the credential lapses, if it does. */
	expiresAt?: string;
	/** Web Push is available: the app serves the rooms and a key for it. */
	push?: true;
	/** When an agent's post and a notice are not pushed (a card still is); absent = at any hour. */
	quietHours?: {
		/** `HH:MM`, where the window begins. */
		start: string;
		/** `HH:MM`, where it ends; before `start` when it crosses midnight. */
		end: string;
		/** The IANA zone the times are on. */
		timeZone: string;
	};
}

/** The key a browser subscribes to push against. */
export interface PushKeyView {
	key: string;
}

/** One device of the person that gets push; the id is not the endpoint. */
export interface PushDeviceView {
	id: string;
	label?: string;
	createdAt: string;
	lastOkAt?: string;
}

export interface PushDevicesView {
	devices: PushDeviceView[];
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
	character: CharacterSpec;
	room: string;
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

/**
 * The body of `POST api/agents`, which makes an agent: the fields of the `agent_create` tool, with
 * its model and thinking level. `name` is permanent (lowercase letters, digits and dashes, 1 to 32).
 * `task` is its opening task; without it the agent only exists. The 201 answer is its profile.
 */
export interface AgentCreate {
	name: string;
	displayName: string;
	prompt: string;
	model?: string;
	thinking?: string;
	task?: string;
	/** Fields of its look; any left out come from the look its role suggests. */
	character?: CharacterInput;
	/** Skills it carries, as the Skills pane names them. */
	skills?: string[];
}

/** A skill as the agent sheet offers it: the host's catalog, and whether this agent carries it. */
export interface SkillChoiceView {
	name: string;
	description?: string;
	source: "builtin" | "linked" | "written" | "package";
	/** Built-in skills are carried by every agent and cannot be taken off. */
	builtin: boolean;
	carried: boolean;
	/** Why its file cannot be read, for a skill that is listed but broken. */
	missing?: string;
}

/** `GET api/agents/<name>/skills` and the answer of `PUT`: every skill the host has. */
export interface AgentSkillsView {
	skills: SkillChoiceView[];
}

/** The body of `PUT api/agents/<name>/skills`: the same fields as the `agent_skills` tool. */
export interface AgentSkillsChange {
	add?: string[];
	remove?: string[];
}

/** A group as the app edits it. */
export interface GroupProfileView {
	name: string;
	displayName: string;
	/** Its members, by agent name, in speaking-tie order. */
	members: string[];
	/** The member who answers when nobody else fits. */
	host: string;
	room: string;
}

/** The body of `POST api/groups`; the host is the first member unless given. The 201 answer is the group. */
export interface GroupCreate {
	name: string;
	displayName: string;
	members: string[];
	host?: string;
}

/** The body of `PATCH api/groups/<name>`; `members` is the whole new list. */
export interface GroupPatch {
	displayName?: string;
	members?: string[];
	host?: string;
}

/** An archived agent or group, kept with its history until it is restored or deleted. */
export interface ArchivedEntry {
	kind: "agent" | "group";
	name: string;
	displayName: string;
	/** An agent's picture, a path under the mount. */
	avatar?: string;
	character?: CharacterSpec;
	/** A group's members that are still on the team. */
	members?: string[];
}

/** `GET api/archive`. */
export interface ArchiveView {
	entries: ArchivedEntry[];
}

/** The body of `PUT api/agents/<name>/character`: at most 4 KiB. */
export interface CharacterRequest {
	character: CharacterInput;
}

/** The 400 of `PUT api/agents/<name>/character`: `field` is the path of the offending field. */
export interface CharacterRefusal extends ApiError {
	field: string;
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
			/** When the card opened (ISO 8601, the server's clock), which places it among the room's messages. */
			at?: string;
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
			at?: string;
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
			at?: string;
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

/** What a person gave a question card: one answer, or one per question with the note beside them. */
export type CardAnswer =
	| { kind: "ask"; answer: PromptAnswer }
	| { kind: "questionnaire"; answers: (PromptAnswer | null)[]; note?: string };

/** A card that ended and is kept in its room's history, with how it ended. */
export interface ClosedCard {
	room: string;
	/** The card as it was shown, `at` being when it opened. */
	frame: PromptFrame;
	outcome: PromptOutcome;
	/** Why a `withdrawn` card was taken back. */
	note?: string;
	/** Who answered it, by display name; absent for a card nobody answered. */
	by?: string;
	/** What was answered, for the question cards. */
	answer?: CardAnswer;
	/** When it ended (ISO 8601, the server's clock). */
	closedAt: string;
}

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
			uploads: { perMessage: number; maxBytes: number };
	  }
	/** The message `id` was taken into `room`; `message` is how it was stored. */
	| { type: "accepted"; id: string; room: string; message: RoomMessage }
	/** `id` names the refused `send`; `prompt` names the card whose answer was refused. */
	| { type: "refused"; id?: string; prompt?: string; code: RefusalCode }
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

// ── The workspace files pane ───────────────────────────────────────────────────────────────────

/** A place whose files the pane shows; the client names it by `id`, never by a path. */
export interface WorkspaceRootView {
	id: string;
	label: string;
	writable: boolean;
}

/** `GET api/workspace`. */
export interface WorkspaceRootsView {
	roots: WorkspaceRootView[];
}

export type WorkspaceEntryKind = "file" | "dir" | "symlink" | "other";

export interface WorkspaceEntry {
	name: string;
	kind: WorkspaceEntryKind;
	size: number;
	mtimeMs: number;
	/** For a symlink: whether its target lies inside the root. Outside, it is shown and never opened. */
	inside?: boolean;
	/** For a symlink inside the root: what it points to. */
	target?: "file" | "dir" | "other";
}

/** `GET api/workspace/<root>/list?path=`. */
export interface WorkspaceListView {
	path: string;
	entries: WorkspaceEntry[];
	/** The directory held more than the 2,000 entries listed. */
	truncated: boolean;
	/** The root's directory does not exist (yet); the app never creates it. */
	missing?: boolean;
}

/** Why a file cannot be edited. */
export type WorkspaceReadOnlyReason =
	| "read-only-root"
	| "git-dir"
	| "trash"
	| "symlink"
	| "binary"
	| "too-large"
	| "not-utf8";

/** The language a file's highlighting is loaded for. */
export type WorkspaceLanguage =
	| "typescript"
	| "javascript"
	| "json"
	| "markdown"
	| "css"
	| "html"
	| "python"
	| "yaml"
	| "go"
	| "rust"
	| "sql"
	| "xml"
	| "shell"
	| "toml"
	| "dockerfile"
	| "plain";

/** `GET api/workspace/<root>/file?path=`. */
export interface WorkspaceFileView {
	path: string;
	size: number;
	mtimeMs: number;
	/** SHA-256 of the file's bytes, in hex; a save carries it back as `baseHash`. */
	hash: string;
	editable: boolean;
	reason?: WorkspaceReadOnlyReason;
	binary: boolean;
	/** Over the 2 MiB the pane highlights: metadata and download only. */
	tooLarge: boolean;
	/** The line separator the file mostly uses. */
	eol: "\n" | "\r\n";
	/** The file starts with a UTF-8 byte order mark, which the text leaves out and a save puts back. */
	bom: boolean;
	language: WorkspaceLanguage;
	/** What the browser can show of the file from the `raw` route: a picture, a PDF, a sound or a video. */
	media?: WorkspaceMedia;
	/** The file's text, as written (its separators kept); absent for a binary or too large file. */
	text?: string;
}

/** The kinds of file the pane previews; the `raw` route serves each with a type from an allowlist. */
export type WorkspaceMedia = "image" | "pdf" | "audio" | "video";

/** `PUT api/workspace/<root>/file?path=` body. */
export interface WorkspaceSave {
	text: string;
	baseHash: string;
}

/** What a write answers: the file now. */
export interface WorkspaceSaved {
	hash: string;
	mtimeMs: number;
	size: number;
}

/** A 409: the file is not as the writer saw it. */
export interface WorkspaceConflict extends ApiError {
	conflict: "changed" | "gone" | "exists";
	/** The file as it is now, for `changed`. */
	current?: WorkspaceSaved;
}

/** An error body that names its cause. */
export interface WorkspaceRefusalBody extends ApiError {
	reason: string;
}

/** `POST api/workspace/<root>/new?path=` body. */
export interface WorkspaceNew {
	kind: "file" | "dir";
	/** A new file's first text; default empty. */
	text?: string;
}

/** `POST api/workspace/<root>/rename` body. */
export interface WorkspaceRename {
	from: string;
	to: string;
}

/** One thing in a root's trash. */
export interface WorkspaceTrashItem {
	id: string;
	/** Where it was, relative to the root. */
	path: string;
	name: string;
	kind: "file" | "dir" | "symlink";
	size: number;
	/** ISO 8601, the server's clock. */
	deletedAt: string;
}

/** `GET api/workspace/<root>/trash`. */
export interface WorkspaceTrashView {
	items: WorkspaceTrashItem[];
}
