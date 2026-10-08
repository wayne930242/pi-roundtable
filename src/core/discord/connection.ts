import type { AgentChannels, DashboardBoard } from "../agents/agent-ports.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import type { OwnerOperations } from "../modules/discord-admin/discord-admin.ts";
import type { ChannelExecutor } from "./channel-operations.ts";
import type { ThreadHost } from "./dispatch-threads.ts";

/** What Discord calls a channel, for the web app's lists. */
export type ChannelInfo =
	| { kind: "dm"; name: string }
	| { kind: "guild"; name: string; guild: string; guildId: string };

/** The Discord connection as plugins use it, apart from the chat surface the host drives. */
export interface DiscordConnection {
	/**
	 * The primary owner's direct-message channel.
	 * @deprecated Since 0.9 there may be more than one owner; this is the primary owner's, kept for
	 * plugins written for 0.8. Reach a principal through their own channel instead. Goes away in 1.0.
	 */
	ownerChannel(): Promise<ChannelKey>;
	/**
	 * Sends the primary owner a direct message.
	 * @deprecated Since 0.9 there may be more than one owner; this is the primary owner's, kept for
	 * plugins written for 0.8. Goes away in 1.0.
	 */
	notifyOwner(text: string): Promise<void>;
	/**
	 * What a channel is called: undefined when Discord no longer knows it; throws while the
	 * connection is not ready or Discord cannot be reached.
	 */
	channelInfo(channelId: string): Promise<ChannelInfo | undefined>;
	/** Channel operations for outside agents; undefined until the connection is ready. */
	channelExecutor(): ChannelExecutor | undefined;
	/** Reports deleted server channels by id; register before the connection starts. */
	onChannelDeleted(listener: (channelId: string) => void): void;
	/** The agent server's channels and webhooks. */
	agentChannels(guildId: string): AgentChannels;
	/** The agent server's `#dashboard` and its pinned status message. */
	agentDashboard(guildId: string): DashboardBoard;
	/** Threads for background dispatches, in the channel that started each. */
	threadHost(): ThreadHost;
	/**
	 * Discord reading and management for the owner's agent, checked against what the primary owner
	 * may do on the server, whichever owner's turn calls them; calls fail until the connection is
	 * ready.
	 */
	ownerOperations(): OwnerOperations;
}
