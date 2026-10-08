import { readFileSync } from "node:fs";
import type { RoundtableConfig } from "pi-roundtable";
import { oidcJwtVerifier, webChat } from "pi-roundtable-webchat";
import { hello } from "./plugins/hello.ts";
import { selfCompact } from "./plugins/self-compact.ts";

// Credentials and ids come from .env, which Bun loads on its own; nothing secret belongs in this file.
const env = (name: string): string => process.env[name] ?? "";
const list = (name: string): string[] =>
	env(name)
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);

export default {
	name: "Roundtable",
	// The operator who runs this host, as the host's owner. People sign in through your OpenID
	// Connect provider instead; core access maps their verified, surface-prefixed roles to tiers.
	access: {
		owners: [{ name: env("OWNER_NAME"), principal: "operator" }],
		members: {
			roles: list("CHAT_MEMBER_ROLES").map((role) => `web:role:${role}`),
		},
		admins: {
			roles: list("CHAT_ADMIN_ROLES").map((role) => `web:role:${role}`),
		},
	},
	database: { url: env("DATABASE_URL") },
	// Paths are relative to the project directory, where the roundtable command runs.
	dataDir: "./data",
	model: env("MODEL"),
	// Serve behind a reverse proxy that terminates TLS; the web chat lives under /chat.
	http: { port: 3000, hostname: "127.0.0.1" },
	plugins: [
		selfCompact,
		hello,
		webChat({
			// Accepts only a person's access token. Pin your tenant and pick a stable subject claim
			// with subjectClaim and check: see "Provider settings" in the pi-roundtable-webchat README.
			verifier: oidcJwtVerifier({
				jwksUrl: env("OIDC_JWKS_URL"),
				issuers: [env("OIDC_ISSUER")],
				audiences: [env("OIDC_AUDIENCE")],
			}),
			origins: list("CHAT_ORIGINS"),
			personas: [
				{
					kind: "assistant",
					label: "Assistant",
					prompt: () => readFileSync("./persona/assistant.md", "utf8"),
					// The tools of its turns, by name. Schedules, delegated reports and notify can reach
					// this private conversation; add those tools only where intended and permitted by tier.
					// Leave out web_search and fetch_content unless people may make the server fetch any address.
					selection: { tools: ["hello_greet"], groups: [] },
				},
			],
		}),
	],
} satisfies RoundtableConfig;
