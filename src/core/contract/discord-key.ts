import type { ChannelKey } from "../domain/conversation.ts";
import { channelKey, parseChannelKey } from "./surface.ts";

/** The surface of Discord's channels, whose keys are `discord:<channel id>`. */
const DISCORD_SURFACE = "discord";

/** The key of a Discord channel. */
export const discordKey = (channelId: string): ChannelKey =>
	channelKey(DISCORD_SURFACE, channelId);

/** The Discord channel id of a key, or undefined when the key belongs to another surface. */
export function discordIdOf(channel: ChannelKey): string | undefined {
	const { surface, id } = parseChannelKey(channel);
	return surface === DISCORD_SURFACE ? id : undefined;
}
