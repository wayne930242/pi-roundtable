import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { defineRoundtable } from "../define-roundtable.ts";
import { ConfigError } from "../domain/errors.ts";
import { silentLogger } from "../log.ts";
import { type RoundtableConfig, resolveConfig } from "./config.ts";

const PEER = "800000000000000001";

const discord = {
	token: "token",
	guild: "900000000000000001",
	entryChannel: "900000000000000002",
};

const minimal: RoundtableConfig = {
	owner: { id: "100000000000000001", name: "Ada" },
	discord,
	database: { url: "postgres://localhost/roundtable" },
	dataDir: "/data",
	model: "anthropic/claude-sonnet-5-5",
	http: { publicUrl: "https://bot.example.com" },
};

const withPeers = (peerBots: unknown): RoundtableConfig =>
	({ ...minimal, discord: { ...discord, peerBots } }) as RoundtableConfig;

const refused = (input: unknown): string => {
	try {
		resolveConfig(input);
	} catch (error) {
		if (error instanceof ConfigError) return error.message;
		throw error;
	}
	return "";
};

describe("discord.peerBots", () => {
	test("is absent unless configured", () => {
		expect(resolveConfig(minimal).discord?.peerBots).toBeUndefined();
	});

	test("takes ids, entries limited to servers or channels, and the rounds", () => {
		const given = {
			allow: [
				PEER,
				{ id: "800000000000000002", channels: ["700000000000000001"] },
			],
			maxRounds: 2,
		};
		expect(resolveConfig(withPeers(given)).discord?.peerBots).toEqual(given);
	});

	test("refuses a name, a wildcard, or a bad id, naming the key", () => {
		expect(refused(withPeers({ allow: ["merlin"] }))).toContain(
			"config discord.peerBots.allow[0]: expected a Discord id",
		);
		expect(refused(withPeers({ allow: [PEER, "*"] }))).toContain(
			"config discord.peerBots.allow[1]",
		);
		expect(
			refused(withPeers({ allow: [{ id: PEER, guilds: ["guild"] }] })),
		).toContain("config discord.peerBots.allow[0].guilds[0]");
		expect(refused(withPeers({ allow: [PEER], all: true }))).toContain(
			"config discord.peerBots.all: unknown key",
		);
		expect(refused(withPeers({}))).toContain("config discord.peerBots.allow");
		expect(refused(withPeers({ allow: [PEER], maxRounds: 0 }))).toContain(
			"config discord.peerBots.maxRounds",
		);
	});

	test("reaches the host's options, and a host without it has none", async () => {
		const dir = mkdtempSync(join(tmpdir(), "roundtable-peers-"));
		const modelRuntime = await ModelRuntime.create({
			authPath: join(dir, "auth.json"),
			modelsPath: join(dir, "models.json"),
		});
		const defined = (input: RoundtableConfig) =>
			defineRoundtable(input, { modelRuntime, logger: silentLogger() });
		const given = { allow: [PEER] };
		expect((await defined(withPeers(given))).options.peerBots).toEqual(given);
		expect((await defined(minimal)).options.peerBots).toBeUndefined();
	});
});
