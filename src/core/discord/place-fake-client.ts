import { type Client, DiscordAPIError } from "discord.js";

/** What a stand-in server says of a channel id. */
export interface FakeServer {
	/** The server the agent guild is. */
	guild: string;
	/** Whether the channel was deleted. */
	gone(id: string): boolean;
	/** Whether the channel is one of another server. */
	foreign(id: string): boolean;
}

/**
 * A discord.js client that only answers `channels.fetch`, as a place provider's `check` asks it:
 * a channel of the agent guild, one of another server, or Discord's own "unknown channel".
 */
export function fakeDiscordClient(server: FakeServer): Client {
	const fetch = async (id: string) => {
		if (server.gone(id))
			throw new DiscordAPIError(
				{ message: "Unknown Channel", code: 10003 },
				10003,
				404,
				"GET",
				`/channels/${id}`,
				{},
			);
		return {
			isDMBased: () => false,
			guildId: server.foreign(id) ? "999999999999999999" : server.guild,
		};
	};
	// SAFETY: the provider reads nothing of the client but `channels.fetch`.
	return { channels: { fetch } } as unknown as Client;
}
