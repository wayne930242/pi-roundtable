// The package's one entry: the plugin, its options, and the built-in verifier.

export type {
	AgentView,
	ApiError,
	ChannelName,
	ConfigView,
	ConnectorsView,
	ContextView,
	ConversationKind,
	ConversationsView,
	ConversationView,
	DashboardView,
	GroupView,
	NoteInput,
	NoteKind,
	NoteView,
	OverviewView,
	PaneName,
	PartyView,
	PrincipalName,
	PrincipalsView,
	SkillDetailView,
	SkillView,
	TranscriptEntry,
	TranscriptRole,
	TranscriptView,
} from "./api-types.ts";
export { PANES } from "./api-types.ts";
export type { CloudflareAccessOptions } from "./cloudflare-access.ts";
export {
	cloudflareAccess,
	cloudflareAccessIdentity,
} from "./cloudflare-access.ts";
/** Summary for a trusted host's separately stored party sessions. */
export { conversationFiles as sessionSummary } from "./conversations.ts";
export type { ConsoleFeatures, ConsolePresentation } from "./features.ts";
export type { WebConsoleOptions } from "./options.ts";
export { DEFAULT_RELAY_NOTE } from "./options.ts";
export type { RequestVerifier, Verdict } from "./verifier.ts";
export { admit, admitAs, refuse } from "./verifier.ts";
export { webConsole } from "./web-plugin.ts";
