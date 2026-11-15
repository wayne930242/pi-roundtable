import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type RoundtableConfig, resolveConfig } from "../config/config.ts";
import { ConfigError } from "../domain/errors.ts";
import { defineRoundtable } from "../host/define-roundtable.ts";
import { silentLogger } from "../kernel/log.ts";
import type { PluginContext, RoundtablePlugin } from "../plugin-api/plugin.ts";
import { THREADS } from "../plugin-api/services.ts";
import { DISCORD, type DiscordServices, discordPlugin } from "./discord.ts";

const config = (discord: object = {}): RoundtableConfig =>
	({
		owner: { id: "100000000000000001", name: "Ada" },
		discord: {
			token: "token",
			guild: "900000000000000001",
			entryChannel: "900000000000000002",
			...discord,
		},
		database: { url: "postgres://localhost/roundtable" },
		dataDir: mkdtempSync(join(tmpdir(), "roundtable-voice-")),
		model: "anthropic/claude-sonnet-5-5",
		http: { publicUrl: "https://bot.example.com" },
	}) as RoundtableConfig;

/** Sets the Discord plugin up alone and answers what it provides and the services it runs. */
async function setUp(plugin: RoundtablePlugin) {
	let provided: DiscordServices | undefined;
	const contribution = await plugin.setup({
		logger: silentLogger(),
		queue: {},
		conversations: {},
		services: {
			find: () => undefined,
			get: (key: { id: string }) => {
				if (key.id === THREADS.id) return {};
				throw new Error(`unexpected service ${key.id}`);
			},
			provide: (key: { id: string }, value: DiscordServices) => {
				if (key.id === DISCORD.id) provided = value;
			},
		},
	} as unknown as PluginContext);
	if (!provided) throw new Error("the discord plugin provided no DISCORD");
	return {
		provided,
		services: (contribution.services ?? []).map(({ name }) => name),
	};
}

test("discord.voice is off unless the configuration turns it on, and takes only a boolean", () => {
	expect(resolveConfig(config()).discord?.voice).toBe(false);
	expect(resolveConfig(config({ voice: true })).discord?.voice).toBe(true);
	expect(() => resolveConfig(config({ voice: "yes" }))).toThrow(ConfigError);
	expect(() => resolveConfig(config({ voice: "yes" }))).toThrow(
		/config discord\.voice/,
	);
});

test("the Discord plugin provides voice and runs its service only with voice on", async () => {
	const options = {
		token: "token",
		ownerId: "1",
		ownerName: "Ada",
		rootCommand: "bot",
		dataDir: mkdtempSync(join(tmpdir(), "roundtable-voice-")),
	};
	const off = await setUp(discordPlugin(options));
	expect(off.provided.voice).toBeUndefined();
	expect("voice" in off.provided).toBe(false);
	expect(off.services).toEqual(["card-copies"]);

	const on = await setUp(discordPlugin({ ...options, voice: true }));
	expect(on.services).toEqual(["card-copies", "discord-voice"]);
	// Plugins get the two calls and nothing of the service's own start and stop.
	expect(Object.keys(on.provided.voice ?? {})).toEqual(["join", "session"]);
	expect(on.provided.voice?.session("100000000000000001")).toBeUndefined();
	// Before the connection is ready a join answers, and reaches for nothing.
	expect(
		await on.provided.voice?.join({
			guildId: "100000000000000001",
			channelId: "200000000000000001",
		}),
	).toMatchObject({ ok: false, failure: "unavailable" });
});

test("the configuration's discord.voice reaches the Discord plugin the host is assembled with", async () => {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-voice-"));
	const modelRuntime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: join(dir, "models.json"),
	});
	const provided = async (discord: object) => {
		const { plugins } = await defineRoundtable(config(discord), {
			modelRuntime,
			logger: silentLogger(),
		});
		const plugin = plugins.find(({ name }) => name === "discord");
		if (!plugin) throw new Error("the host has no discord plugin");
		return (await setUp(plugin)).provided;
	};
	expect((await provided({})).voice).toBeUndefined();
	expect((await provided({ voice: false })).voice).toBeUndefined();
	expect(typeof (await provided({ voice: true })).voice?.join).toBe("function");
});
