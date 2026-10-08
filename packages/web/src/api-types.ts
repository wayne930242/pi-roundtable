// The console's API shapes, shared by the server (`src/`) and the page (`web/`). Times are ISO strings.

/** The panes the console can show; the options choose which ones a host serves. */
export const PANES = [
	"overview",
	"conversations",
	"notes",
	"skills",
	"connectors",
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
	channelId: string;
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
		| { kind: "written" };
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
