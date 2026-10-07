import type { RoundtableConfig } from "pi-roundtable";
import { agents } from "./agents.ts";
import { hello } from "./plugins/hello.ts";
import { selfCompact } from "./plugins/self-compact.ts";

// Credentials and ids come from .env, which Bun loads on its own; nothing secret belongs in this file.
const env = (name: string): string => process.env[name] ?? "";

export default {
	name: "Roundtable",
	// Who the host serves. You are the owner: your principal and your Discord identity are your
	// Discord user id. Add admins and members by Discord user or role, such as
	// members: { roles: ["discord:role:<role id>"] }.
	access: {
		owners: [
			{
				name: env("OWNER_NAME"),
				principal: env("OWNER_ID"),
				identities: [`discord:${env("OWNER_ID")}`],
			},
		],
	},
	discord: {
		token: env("DISCORD_TOKEN"),
		guild: env("DISCORD_GUILD_ID"),
		entryChannel: env("DISCORD_ENTRY_CHANNEL_ID"),
	},
	database: { url: env("DATABASE_URL") },
	// Paths are relative to the project directory, where the roundtable command runs.
	dataDir: "./data",
	model: env("MODEL"),
	http: { publicUrl: env("PUBLIC_URL") },
	prompts: { shared: "./persona/shared.md" },
	agents,
	plugins: [selfCompact, hello],
} satisfies RoundtableConfig;
