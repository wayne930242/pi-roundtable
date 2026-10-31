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
	"profile",
] as const;
export type PaneName = (typeof PANES)[number];

/**
 * The panes only an owner is served: they show the whole host, which a member's view never does.
 * The table is not among them: for a member it seats only the host rooms they may list.
 */
export const OWNER_ONLY_PANES = [
	"overview",
	"skills",
	"connectors",
	"workspace",
] as const satisfies readonly PaneName[];

/** A person's tier in the app, as `IDENTITY` gives it. */
export type AppTier = "owner" | "admin" | "member";

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
	/** Which parts of the Connectors page the host serves; each is absent when it does not. */
	connectorParts?: { gateways?: true; manage?: true; grants?: true };
	/** Only supplied for path-based routing; also the base for page/API URLs. */
	mountPath?: string;
	/** Present when the `rooms` pane is served: how the page opens the owner app's socket. */
	app?: {
		/** The key prefix of the app's rooms, such as `app`. */
		surface: string;
		/** The WebSocket subprotocol to offer. */
		protocol: string;
		/** False when the host leaves the yolo and long-running switches out (`modes: false`). */
		modes?: false;
	};
	/** The visitor's tier. Sent only where the host admits more than its owners (`admission: "access"`). */
	tier?: AppTier;
	/** The steps still undone before the app opens; present only while the gate is closed. */
	gate?: GateStepView[];
	/** The host's pages that are not rooms, as far as this visitor may see them. */
	pages?: PageLinkView[];
	/** The kinds of host room this visitor may list. */
	kinds?: KindLinkView[];
	/** Web Push for this visitor's tier: who may subscribe, and (for an external sender) where. */
	push?: { tiers: AppTier[]; key?: string; subscribe?: string };
}

/** A step of onboarding the visitor still owes. */
export interface GateStepView {
	id: string;
	label: string;
	help?: string;
	/**
	 * Set on the steps the app makes itself, so the page words them in its own language: `link`
	 * for `link:<provider>` (with the account's label in `label`), `push` for the notifications step.
	 */
	builtin?: "link" | "push";
	/** A required step gates the app; a nudge is shown and never gates. */
	required: boolean;
	/** The page where the person completes it. */
	open: { page: string };
	/** The person may waive it; the label and the confirmation are what they are shown. */
	waiver?: { label: string; confirm: string };
}

/**
 * The icons a host may give a page or a kind of room: names from the console's own icon set. A
 * name outside the list, or none, shows the default (a list for a page, no icon for a kind).
 */
export const HOST_ICONS = [
	"chat",
	"link",
	"activity",
	"users",
	"megaphone",
	"qr",
	"settings",
	"bell",
	"file",
	"list",
	"shield",
	"lock",
	"sparkle",
] as const;
export type HostIconName = (typeof HOST_ICONS)[number];

/**
 * How a kind of host room words its two ways to write: `turn` is talking to the agent (the toggle's
 * label, and the box's hint while it is on), `note` is a message for the room's people only.
 */
export interface SendWording {
	note?: { placeholder?: string };
	turn?: { label?: string; placeholder?: string };
}

/** A host page that is not a room, in the places the shell lists it. */
export interface PageLinkView {
	id: string;
	label: string;
	place: "main" | "settings" | "hidden";
	icon?: HostIconName;
}

/** A kind of host room, listed by its label. */
export interface KindLinkView {
	kind: string;
	label: string;
	icon?: HostIconName;
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

/** A connector as the page shows it: the URL is scheme and host only, and no token is ever in it. */
export interface ManagedConnectorView {
	name: string;
	/** Absent when the URL cannot be parsed. */
	displayUrl?: string;
	description: string;
	/** Absent when its tools could not be read. */
	tools?: number;
}

export interface ConnectorInput {
	name: string;
	url: string;
	description: string;
	header?: string;
	/** Write-only: sent once, never returned. */
	token?: string;
}

export interface ConnectorAddedView {
	connector: ManagedConnectorView;
	skipped: string[];
}

export interface McpGrantView {
	channelId: string;
	guildName: string;
	channelName: string;
	visible: boolean;
	displayName: string;
	description: string;
	operations: string[];
	authorizedAt: string;
	audit: { tool: string; status: string; at: string }[];
}

export interface McpGrantsView {
	operations: { id: string; label: string }[];
	bundles: { name: string; grants: McpGrantView[] }[];
}

export interface McpChannelView {
	id: string;
	name: string;
	guild: string;
}

export interface McpAuthorizeInput {
	bundle: string;
	channelId: string;
	operations: string[];
	displayName?: string;
	description?: string;
}

/** A bundle URL, shown once: after a rotation, or when an authorization created the bundle. */
export interface McpUrlView {
	bundle: string;
	url?: string;
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
	/**
	 * An internal note: written for the humans who read the room, never handed to the agent. Only
	 * an `owner` message of an agent or group room that has `notes` can be one.
	 */
	note?: true;
	/** Files of the message that were deleted by retention. */
	expiredFiles?: number;
}

/** The kinds of author a host room's messages come from. */
export type HostAuthorKind = "external" | "member" | "assistant" | "notice";

/** A picture the page may draw: a stored file, a person's picture, or initials; never an outside URL. */
export type PictureRef =
	| { file: string }
	| { principal: string }
	| { initials: string; color: string };

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
	 * A temp knight's room: `parent` is the room of the knight that made it, and `finished` is set
	 * when it has nothing running, queued or waiting. Absent on every permanent knight.
	 */
	helper?: { parent: string; parentName: string; finished?: true };
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

/** Who the page is signed in as. */
export interface SessionView {
	principal: PrincipalName;
	surface: string;
	/** How the console signs the person in; the page offers Log out under `password` and `oidc`. */
	auth: "none" | "password" | "verifier" | "oidc";
	/** The visitor's tier. Sent only where the host admits more than its owners (`admission: "access"`). */
	tier?: AppTier;
	/** The steps still undone before the app opens; present only while the gate is closed. */
	gate?: GateStepView[];
	/** When the credential lapses, if it does. */
	expiresAt?: string;
	/** Web Push is available: the app serves the rooms and a key for it. */
	push?: true;
	/** The host has prompt documents the owner edits (`api/prompts`). */
	prompts?: true;
	/** The host has the skills addon, so an agent-written skill's SKILL.md can be edited and made here (`api/skill-docs`). */
	skillEdit?: true;
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

/** A test push was queued; the device's receipt for `tag` completes the push step. */
export interface PushTestView {
	tag: string;
}

/** The person's own push preferences. */
export interface PushPrefsView {
	/** No push for a normal notice from `start` to `end` on the clock of `timeZone`; absent = none set. */
	quiet?: { start: string; end: string; timeZone: string };
}

/** The person's notices that are not resolved, newest first, and the count the app icon shows. */
export interface NoticesView {
	notices: NoticeView[];
	badge: number;
}

/** One account the person may link, as the profile page shows it. */
export interface LinkView {
	provider: string;
	label: string;
	/** What linking it is for this deployment: `required` gates the app, `nudge` asks; absent = optional. */
	step?: "required" | "nudge";
	/** Providers to link first, and those of them not linked yet (`issue` is refused until none is left). */
	requires: string[];
	blockedBy: string[];
	linked?: {
		displayName?: string;
		/** ISO time. */
		linkedAt: string;
		/** The configuration or the CLI made the link, so it cannot be removed here. */
		locked?: true;
	};
	pending?: {
		request: string;
		/** ISO time. */
		expiresAt: string;
		redeemedBy?: { displayName: string; picture?: PictureRef };
	};
}

export interface LinksView {
	links: LinkView[];
}

/** The code a person puts into the other service to prove an account. */
export interface LinkIssuedView {
	code: string;
	request: string;
	/** ISO time. */
	expiresAt: string;
	instructions: string;
}

/** How the person is shown, and which of their accounts they may pick to show. */
export interface ProfileView {
	name: string;
	/** The account the name comes from; absent when it is the person's own name. */
	source?: string;
	/** A picture is served at `api/people/<principal>/picture`. */
	picture: boolean;
	principal: string;
	tier?: AppTier;
	/** The accounts the person linked that can name them; the page shows these as the choice. */
	sources: { provider: string; label: string }[];
}

/** A step of onboarding as the page of steps shows it. */
export interface OnboardingStepView extends GateStepView {
	done: boolean;
	waived: boolean;
}

export interface OnboardingView {
	steps: OnboardingStepView[];
	/** Push on the person's devices: how many are subscribed and when one last reported back. */
	push: { devices: number; lastReceiptAt?: string; waived: boolean };
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
	/** A temp knight's profile: the room of the knight that made it, and its name. */
	helper?: { parent: string; parentName: string };
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

/** One change of a prompt, as `GET api/agents/<name>/prompt-history` and `GET api/prompts/<id>/history` list them, newest first. */
export interface PromptVersionView {
	id: number;
	/** `set` put new text in force; `revert` took a document back to its file version. */
	action: "set" | "revert";
	/** The text in force after the change; for a revert, the file version it went back to. */
	text: string;
	/** The text the change replaced. */
	previous: string;
	/** Who made it. */
	by: string;
	/** ISO time. */
	at: string;
}

export interface PromptHistoryView {
	versions: PromptVersionView[];
}

/** A prompt document in the list of `GET api/prompts`: the owner-editable texts the host registered. */
export interface PromptSummary {
	id: string;
	label: string;
	description?: string;
	/** The owner's text is in force and is not the file version. */
	differs: boolean;
	/** Who set it and when (ISO), while an override is in force. */
	override?: { by: string; at: string };
	/** Why the file version cannot be read; the document cannot be changed until it can, and the others are unaffected. */
	broken?: string;
}

export interface PromptsView {
	documents: PromptSummary[];
}

/** `GET api/prompts/<id>`: the document with its text in force and its file version. */
export interface PromptView extends PromptSummary {
	/** The text in force. */
	text: string;
	/** The file version, which `revert` returns to. */
	fileText: string;
	/** The most characters a save may have. */
	maxChars: number;
}

/** The body of `PUT api/prompts/<id>`: the new text, and the text it was edited from. */
export interface PromptSave {
	text: string;
	base: string;
}

/** The body of `POST api/prompts/<id>/revert`: the text in force that the owner saw when they asked. */
export interface PromptRevert {
	base: string;
}

/** A 409: the document is not as the writer saw it. */
export interface PromptConflict extends ApiError {
	conflict: "changed";
	current: PromptView;
}

/** A skill's SKILL.md as `GET api/skill-docs/<name>` answers: the whole file, with the hash a save names. */
export interface SkillDocView {
	name: string;
	source: SkillView["source"];
	text: string;
	hash: string;
	/** An agent-written skill; the others are read-only here, for the reason their source gives. */
	writable: boolean;
}

/** The body of `PUT api/skill-docs/<name>`: the whole file, and the hash it was edited from. */
export interface SkillDocSave {
	text: string;
	baseHash: string;
}

/** The body of `POST api/skill-docs`, which makes a skill from a whole SKILL.md. */
export interface SkillDocCreate {
	text: string;
}

/** The answer of `DELETE api/skill-docs/<name>`: the registry's words, naming the agents it was detached from. */
export interface SkillDeleted {
	message: string;
}

/** A 409: the skill is not as the writer saw it. */
export interface SkillConflict extends ApiError {
	conflict: "changed";
	current: SkillDocView;
}

export interface SkillVersionView {
	id: number;
	text: string;
	hash: string;
	by: string;
	/** ISO time. */
	at: string;
}

export interface SkillHistoryView {
	versions: SkillVersionView[];
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
	/** A temp knight's parent, by name; the archive page groups it under that knight. */
	parent?: string;
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
	| "not_accepted"
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

export type ServerFrame =
	/** The socket is authenticated; sent first, and followed by every open card. */
	| {
			type: "ready";
			protocol: typeof APP_PROTOCOL_VERSION;
			principal: string;
			name: string;
			/** The most files one message carries and the most bytes of one. */
			uploads: { perMessage: number; maxBytes: number };
			/** The required steps the person still owes, when there are any: the socket then carries only the gate and their notices. */
			gate?: GateStepView[];
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
	| { type: "mode"; room: string; yolo: boolean; longRunning: boolean }
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
