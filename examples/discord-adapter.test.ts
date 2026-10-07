import { expect, test } from "bun:test";
import { $ } from "bun";
import { defineRoundtable, type RoundtableConfig } from "pi-roundtable";
import { silentLogger } from "pi-roundtable/testing";
import { withDiscordAdapter } from "./discord-adapter.ts";

const ENV: Record<string, string> = {
	OWNER_ID: "100000000000000001",
	OWNER_NAME: "Ada",
	DISCORD_TOKEN: "token",
	DISCORD_GUILD_ID: "900000000000000001",
	DISCORD_ENTRY_CHANNEL_ID: "900000000000000002",
	DATABASE_URL: "postgres://localhost/roundtable",
	MODEL: "anthropic/claude-sonnet-5-5",
	PUBLIC_URL: "https://bot.example.com",
};

test("a Discord adapter assembles the plugins the top-level discord does, in the same order", async () => {
	const dataDir = `${Bun.env.TMPDIR ?? "/tmp"}/discord-adapter-${crypto.randomUUID()}`;
	const adapted = withDiscordAdapter((name) => ENV[name] ?? "", dataDir);
	const { adapters: _adapters, ...rest } = adapted;
	const topLevel: RoundtableConfig = {
		...rest,
		discord: {
			token: "token",
			guild: "900000000000000001",
			entryChannel: "900000000000000002",
		},
	};
	const names = async (config: RoundtableConfig) =>
		(await defineRoundtable(config, { logger: silentLogger() })).plugins.map(
			(plugin) => plugin.name,
		);
	try {
		const plugins = await names(adapted);
		expect(plugins).toContain("discord");
		expect(plugins).toContain("agent-server");
		expect(plugins).toEqual(await names(topLevel));
	} finally {
		await $`rm -rf ${dataDir}`;
	}
});
