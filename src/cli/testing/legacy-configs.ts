/**
 * Configurations as 0.8 wrote them, for `roundtable upgrade`. Each is a whole
 * `roundtable.config.ts` that loads on its own: it imports nothing but types and reads no `.env`.
 */

/** The template `roundtable init` made in 0.8.0, word for word; it reads its ids from `.env`. */
export const TEMPLATE_0_8 = `import type { RoundtableConfig } from "pi-roundtable";
import { agents } from "./agents.ts";
import { hello } from "./plugins/hello.ts";
import { selfCompact } from "./plugins/self-compact.ts";

// Credentials and ids come from .env, which Bun loads on its own; nothing secret belongs in this file.
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
	// Paths are relative to the project directory, where the roundtable command runs.
	dataDir: "./data",
	model: env("MODEL"),
	http: { publicUrl: env("PUBLIC_URL") },
	prompts: { shared: "./persona/shared.md" },
	agents,
	plugins: [selfCompact, hello],
} satisfies RoundtableConfig;
`;

const BASE = `	database: { url: "postgres://roundtable@localhost:5432/roundtable" },
	dataDir: "./data",
	model: "anthropic/claude-sonnet-5-5",
	http: { publicUrl: "https://bot.example.test" },`;

const DISCORD = `	discord: {
		token: "bot-token",
		guild: "900000000000000001",
		entryChannel: "900000000000000002",
	},`;

/** Every 0.8 shape of `owner` and `speakers` the upgrade rewrites, by what it shows. */
export const LEGACY_CONFIGS: Record<string, string> = {
	"literal ids, pronouns, and every tier": `import type { RoundtableConfig } from "pi-roundtable";

export default {
	name: "Roundtable",
	owner: { id: "900000000000000003", name: "Ada", pronouns: "she" },
	speakers: {
		admins: { users: ["900000000000000004"], roles: ["900000000000000005"] },
		members: { roles: ["900000000000000006", "900000000000000007"], everyone: true },
	},
${DISCORD}
${BASE}
} satisfies RoundtableConfig;
`,
	"ids from expressions, a list from the environment, and everyone by a condition": `import type { RoundtableConfig } from "pi-roundtable";

const OWNER = "900000000000000003";
const list = (value: string | undefined): string[] =>
	value ? value.split(",") : [];

export default {
	owner: { id: OWNER, name: \`Ada \${"Lovelace"}\` },
	speakers: {
		admins: { users: list("900000000000000004,900000000000000008") },
		members: {
			users: [OWNER.replace("3", "9")],
			roles: list(undefined),
			everyone: process.env.ROUNDTABLE_OPEN === "1",
		},
	},
${DISCORD}
${BASE}
} satisfies RoundtableConfig;
`,
	"an exported constant, shorthand owner keys, everyone false, and comments": `import type { RoundtableConfig } from "pi-roundtable";

const id = "900000000000000003";
const name = "Ada";

const config = {
	// The owner runs the host.
	owner: { id, name /* their first name */ },
	// Members by role.
	speakers: {
		members: { roles: ["900000000000000006"], everyone: false }, // only the role
	},
${DISCORD}
${BASE}
} satisfies RoundtableConfig;

export default config;
`,
	"Discord already an adapter": `import type { RoundtableConfig } from "pi-roundtable";
import { discord } from "pi-roundtable/discord";

export default {
	owner: { id: "900000000000000003", name: "Ada" },
	adapters: [
		discord({
			token: "bot-token",
			guild: "900000000000000001",
			entryChannel: "900000000000000002",
		}),
	],
${BASE}
} satisfies RoundtableConfig;
`,
	"no Discord at all": `import type { RoundtableConfig } from "pi-roundtable";

export default {
	owner: { id: "operator", name: "Ada", pronouns: "they" },
	speakers: { members: { everyone: true } },
	database: { url: "postgres://roundtable@localhost:5432/roundtable" },
	dataDir: "./data",
	model: "anthropic/claude-sonnet-5-5",
} satisfies RoundtableConfig;
`,
};
