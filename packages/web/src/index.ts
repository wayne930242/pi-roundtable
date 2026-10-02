// The package's one entry: the plugin, its options, and the built-in verifier.

export type {
	AgentView,
	ApiError,
	ChannelName,
	ConfigView,
	ContextView,
	ConversationKind,
	ConversationsView,
	ConversationView,
	GroupView,
	NoteInput,
	NoteKind,
	NoteView,
	OverviewView,
	PaneName,
	TranscriptEntry,
	TranscriptRole,
	TranscriptView,
} from "./api-types.ts";
export { PANES } from "./api-types.ts";
export type { CloudflareAccessOptions } from "./cloudflare-access.ts";
export { cloudflareAccess } from "./cloudflare-access.ts";
export type { WebConsoleOptions } from "./options.ts";
export { DEFAULT_RELAY_NOTE } from "./options.ts";
export type { RequestVerifier, Verdict } from "./verifier.ts";
export { admit, refuse } from "./verifier.ts";
export { webConsole } from "./web-plugin.ts";
