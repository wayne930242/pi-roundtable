// The Discord entry: everything that names a discord.js type, apart from the main and kit entries.
// Versioned like the main entry: a breaking change comes in a minor release before 1.0 and is listed in the changelog.

export type { DiscordServices } from "../core/builtin/discord.ts";
export { DISCORD } from "../core/builtin/discord.ts";
export type { DiscordAdapterConfig } from "../core/config/config.ts";
export type { AgentPanelMessage } from "../core/discord/agent-commands.ts";
export type {
	AgentPanel,
	AgentPanelOptions,
} from "../core/discord/agent-panel.ts";
export { agentPanel } from "../core/discord/agent-panel.ts";
export type {
	ChannelContext,
	ChannelContextMessage,
	ChannelContextOptions,
} from "../core/discord/channel-context.ts";
export {
	CHANNEL_CONTEXT_DEFAULTS,
	withChannelContext,
} from "../core/discord/channel-context.ts";
export type { ManagedChannel } from "../core/discord/channel-executor.ts";
export {
	fetchManagedChannel,
	OPERATION_PERMISSIONS,
} from "../core/discord/channel-executor.ts";
export type {
	ChannelExecutor,
	ChannelOperation,
	ChannelTool,
} from "../core/discord/channel-operations.ts";
export {
	CHANNEL_OPERATIONS,
	CHANNEL_TOOLS,
	ChannelToolError,
	isChannelOperation,
	operationLabel,
	parseChannelTool,
} from "../core/discord/channel-operations.ts";
export type { ComposedCommands } from "../core/discord/compose-commands.ts";
export { composeCommands } from "../core/discord/compose-commands.ts";
export type {
	ChannelInfo,
	DiscordConnection,
} from "../core/discord/connection.ts";
export { discord } from "../core/discord/discord-adapter.ts";
export type { DiscordActor } from "../core/discord/discord-owners.ts";
export type {
	CommandGuard,
	CommandRegistrar,
	CommandRoot,
	InteractionContribution,
	InteractionModule,
	RootOption,
} from "../core/discord/interaction-module.ts";
export type {
	CommandGuardOptions,
	OwnerCommandHandlers,
} from "../core/discord/owner-command.ts";
export {
	commandGuard,
	groupOption,
	ownerCommandModule,
	ownerRootCommand,
} from "../core/discord/owner-command.ts";
export type { PanelContent } from "../core/discord/owner-panel.ts";
export {
	ephemeralPanel,
	OwnerFacingError,
	ownerPanel,
	ownerPanels,
	plain,
	replyWithPanels,
} from "../core/discord/owner-panel.ts";
export type { OwnerOperations } from "../core/modules/discord-admin/discord-admin.ts";
export { DISCORD_ADMIN_TOOLS } from "../core/modules/discord-admin/discord-admin.ts";
