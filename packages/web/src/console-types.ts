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
	/** Its room in the web app, when the app hosts rooms: the conversation a start-over from the web resets. */
	room?: string;
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
	/** Its room in the web app, when the app hosts rooms: the conversation a start-over from the web resets. */
	room?: string;
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
