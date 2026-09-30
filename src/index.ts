// The plugin author's stable entry; internals remain behind package exports.

export type { AgentSeed } from "./core/agents/agent-store.ts";
export type { RoundtableConfig } from "./core/config/config.ts";
export type { ChannelClaim } from "./core/contract/channels.ts";
export type { InteractionContribution } from "./core/contract/discord.ts";
export type { Migration } from "./core/db/migrations.ts";
export type { ToolContribution, ToolSpec, ToolTurn } from "./core/define.ts";
export { definePlugin, defineTool, ToolRefusal } from "./core/define.ts";
export type { DefinedRoundtable } from "./core/define-roundtable.ts";
export { defineRoundtable } from "./core/define-roundtable.ts";
export { NotLinkedError, PluginError } from "./core/errors.ts";
export type { HoldRule } from "./core/holds.ts";
export type { RoundtableOptions } from "./core/host.ts";
export { Roundtable } from "./core/host.ts";
export type {
	Contribution,
	EventHandlers,
	PluginContext,
	PromptSection,
	PromptTurn,
	RoundtablePlugin,
	Service,
	TurnEndEvent,
	TurnEvent,
} from "./core/plugin.ts";
export type { SessionTool } from "./core/sessions.ts";
export type { Speaker, Tier } from "./core/speakers.ts";
