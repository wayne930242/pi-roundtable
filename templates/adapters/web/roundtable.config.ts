import { readFileSync } from "node:fs";
import type { RoundtableConfig } from "pi-roundtable";
import { oidcJwtVerifier, webChat } from "pi-roundtable-webchat";
import { hello } from "./plugins/hello.ts";

// Credentials and ids come from .env, which Bun loads on its own; nothing secret belongs in this file.
const env = (name: string): string => process.env[name] ?? "";
const list = (name: string): string[] =>
	env(name)
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);

export default {
	name: "Roundtable",
	// The operator who runs this host. People sign in through your OpenID Connect provider instead.
	owner: { id: "operator", name: env("OWNER_NAME") },
	database: { url: env("DATABASE_URL") },
	// Paths are relative to the project directory, where the roundtable command runs.
	dataDir: "./data",
	model: env("MODEL"),
	// Serve behind a reverse proxy that terminates TLS; the web chat lives under /chat.
	http: { port: 3000, hostname: "127.0.0.1" },
	plugins: [
		hello,
		webChat({
			verifier: oidcJwtVerifier({
				jwksUrl: env("OIDC_JWKS_URL"),
				issuers: [env("OIDC_ISSUER")],
				audiences: [env("OIDC_AUDIENCE")],
			}),
			// Members and admins come from the token's roles; owners only from speaker ids you list.
			access: {
				members: { roles: list("CHAT_MEMBER_ROLES") },
				admins: { roles: list("CHAT_ADMIN_ROLES") },
			},
			origins: list("CHAT_ORIGINS"),
			personas: [
				{
					kind: "assistant",
					label: "Assistant",
					prompt: () => readFileSync("./persona/assistant.md", "utf8"),
				},
			],
		}),
	],
} satisfies RoundtableConfig;
