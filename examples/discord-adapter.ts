import type { RoundtableConfig } from "pi-roundtable";
import { discord } from "pi-roundtable/discord";

/**
 * Discord as an adapter: `discord()` takes the same settings as the top-level `discord`, and the
 * host assembles the same plugins in the same order. Configure Discord in one place, not both.
 */
export function withDiscordAdapter(
	env: (name: string) => string,
	dataDir: string,
): RoundtableConfig {
	return {
		owner: { id: env("OWNER_ID"), name: env("OWNER_NAME") },
		adapters: [
			discord({
				token: env("DISCORD_TOKEN"),
				guild: env("DISCORD_GUILD_ID"),
				entryChannel: env("DISCORD_ENTRY_CHANNEL_ID"),
			}),
		],
		database: { url: env("DATABASE_URL") },
		dataDir,
		model: env("MODEL"),
		http: { publicUrl: env("PUBLIC_URL") },
	};
}
