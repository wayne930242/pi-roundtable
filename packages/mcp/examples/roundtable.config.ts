import type { RoundtableConfig } from "pi-roundtable";
import { mcpConnectors, remoteMcp } from "pi-roundtable-mcp";

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
	// The remote MCP endpoints are served on this listener, so PUBLIC_URL must reach it over HTTPS.
	http: { publicUrl: env("PUBLIC_URL") },
	plugins: [
		mcpConnectors({
			contextForge: {
				url: env("CONTEXTFORGE_URL"),
				jwtSecret: env("CONTEXTFORGE_JWT_SECRET"),
				user: env("CONTEXTFORGE_USER"),
			},
		}),
		remoteMcp({
			dispatchToken: env("MCP_DISPATCH_TOKEN"),
			publicUrl: env("PUBLIC_URL"),
		}),
	],
} satisfies RoundtableConfig;
