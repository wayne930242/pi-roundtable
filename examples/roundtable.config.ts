import type { RoundtableConfig } from "pi-roundtable";
import { drawing } from "pi-roundtable-drawing";

// Credentials come from .env, which Bun loads on its own; nothing secret belongs in this file.
const env = (name: string): string => process.env[name] ?? "";

export default {
	name: "Roundtable",
	owner: { id: env("OWNER_ID"), name: env("OWNER_NAME") },
	discord: {
		token: env("DISCORD_TOKEN"),
		guild: env("DISCORD_GUILD_ID"),
		entryChannel: env("DISCORD_ENTRY_CHANNEL_ID"),
	},
	database: { url: env("DATABASE_URL") },
	dataDir: "./data",
	model: env("MODEL"),
	http: { publicUrl: env("PUBLIC_URL") },
	plugins: [
		// The deck directory is optional: without it the plugin has no draw_cards tool.
		drawing({ deckDir: "./decks" }),
	],
} satisfies RoundtableConfig;
