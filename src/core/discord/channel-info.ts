import { ChannelType, type Client, DiscordAPIError } from "discord.js";
import type { ChannelInfo } from "./connection.ts";

/** Discord's error code for a channel that does not exist or cannot be seen. */
const UNKNOWN_CHANNEL = 10003;

/**
 * What a channel is called, for the web app's lists: undefined when Discord no longer knows
 * it; throws while the connection is not ready or Discord cannot be reached.
 */
export async function channelInfoOf(
	client: Client,
	channelId: string,
): Promise<ChannelInfo | undefined> {
	if (!client.isReady()) throw new Error("Discord is not connected");
	const channel = await client.channels
		.fetch(channelId)
		.catch((error: unknown) => {
			if (error instanceof DiscordAPIError && error.code === UNKNOWN_CHANNEL)
				return null;
			throw error;
		});
	if (!channel) return undefined;
	if (channel.isDMBased())
		return {
			kind: "dm",
			name:
				channel.type === ChannelType.DM
					? (channel.recipient?.username ?? "")
					: (channel.name ?? ""),
		};
	return {
		kind: "guild",
		name: channel.name,
		guild: channel.guild.name,
		guildId: channel.guild.id,
	};
}
