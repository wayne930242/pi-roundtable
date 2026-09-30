import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RoundtableConfig } from "../../core/config/config.ts";
import type { DefinedRoundtable } from "../../core/define-roundtable.ts";
import type { Http, HttpResponse } from "../http.ts";
import type { Ports } from "../project.ts";

/** A configuration the schema accepts. */
export const validConfig: RoundtableConfig = {
	owner: { id: "100000000000000001", name: "Ada" },
	discord: {
		token: "bot-token",
		guild: "900000000000000001",
		entryChannel: "900000000000000002",
	},
	database: { url: "postgres://user:secret@db.example.test:5432/bot" },
	dataDir: "/data",
	model: "anthropic/claude-sonnet-5-5",
	http: { publicUrl: "https://bot.example.test" },
};

/** A directory that is removed when the test ends; call `done` in `afterEach`. */
export function tempDir(prefix = "roundtable-cli-"): {
	path: string;
	write(file: string, content: string): void;
	done(): void;
} {
	const path = mkdtempSync(join(tmpdir(), prefix));
	return {
		path,
		write(file, content) {
			mkdirSync(dirname(join(path, file)), { recursive: true });
			writeFileSync(join(path, file), content);
		},
		done: () => rmSync(path, { recursive: true, force: true }),
	};
}

/** Ports that hand out `config`, assemble nothing real, and report a login from `source`. */
export function fakePorts(
	config: unknown = validConfig,
	overrides: Partial<Ports> = {},
): Ports {
	const defined: DefinedRoundtable = {
		options: { logger: {} as never },
		plugins: [{ name: "database", setup: () => ({}) }],
	};
	return {
		loadConfig: async () => config,
		define: async () => defined,
		login: async () => "ANTHROPIC_API_KEY",
		...overrides,
	};
}

/** An HTTP client that answers from `routes`, keyed by the path after the host, and fails on any other. */
export function fakeHttp(
	routes: Record<string, HttpResponse | Error>,
): Http & { requests: string[] } {
	const requests: string[] = [];
	return {
		requests,
		async get(url) {
			const key = url.replace(/^https?:\/\/[^/]+(\/api\/v10)?/, "") || "/";
			requests.push(key);
			const route = routes[key];
			if (route === undefined) throw new Error(`no route for ${key}`);
			if (route instanceof Error) throw route;
			return route;
		},
	};
}

export const BOT_ID = "800000000000000001";

/** Discord as it answers when everything is right: the token is good, the bot is in the guild, with every permission and the intent. */
export function healthyDiscord(
	permissions: bigint,
	guild = validConfig.discord.guild,
	channel = validConfig.discord.entryChannel,
): Record<string, HttpResponse> {
	return {
		"/users/@me": { status: 200, body: { id: BOT_ID, username: "Bot" } },
		"/applications/@me": { status: 200, body: { flags: 1 << 18 } },
		[`/guilds/${guild}`]: {
			status: 200,
			body: {
				name: "Test Guild",
				owner_id: "100000000000000001",
				roles: [
					{ id: guild, permissions: "0" },
					{ id: "700000000000000001", permissions: String(permissions) },
				],
			},
		},
		[`/guilds/${guild}/members/${BOT_ID}`]: {
			status: 200,
			body: { roles: ["700000000000000001"] },
		},
		[`/channels/${channel}`]: {
			status: 200,
			body: { id: channel, guild_id: guild, permission_overwrites: [] },
		},
	};
}
