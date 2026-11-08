import { describe, expect, test } from "bun:test";
import { ConfigError } from "../domain/errors.ts";
import { type RoundtableConfig, resolveConfig } from "./config.ts";

const seeds = [
	{ name: "guide", displayName: "Guide", prompt: "Guide." },
	{ name: "scribe", displayName: "Scribe", prompt: "Write." },
];

/** A bot that serves other guilds and has no agent guild: its team lives in the app. */
const appTeam: RoundtableConfig = {
	owner: { id: "100000000000000001", name: "Ada" },
	discord: { token: "token" },
	agents: seeds,
	database: { url: "postgres://localhost/roundtable" },
	dataDir: "/data",
	model: "anthropic/claude-sonnet-5-5",
} as RoundtableConfig;

const refusal = (input: unknown): string => {
	try {
		resolveConfig(input);
	} catch (error) {
		if (error instanceof ConfigError) return error.message;
		throw error;
	}
	return "";
};

describe("discord without discord.guild", () => {
	test("keeps Discord and runs the agent server with the first seed coordinating, needing no public URL", () => {
		const config = resolveConfig(appTeam);
		expect(config.discord?.token).toBe("token");
		expect(config.discord?.guild).toBeUndefined();
		expect(config.discord?.entryChannel).toBeUndefined();
		expect(config.agentServer).toBe(true);
		expect(config.coordinator).toBe("guide");
		expect(config.http).toBeUndefined();
	});

	test("coordinator names the coordinator", () => {
		expect(
			resolveConfig({ ...appTeam, coordinator: "scribe" }).coordinator,
		).toBe("scribe");
	});

	test("an entry channel is refused, naming the fix", () => {
		const message = refusal({
			...appTeam,
			discord: { token: "token", entryChannel: "900000000000000002" },
		});
		expect(message).toContain("config discord.entryChannel:");
		expect(message).toContain("discord.guild is left out");
	});

	test("no agents is refused, unless agentServer is false", () => {
		const { agents: _, ...noAgents } = appTeam;
		expect(refusal(noAgents)).toContain("config discord.guild: left out");
		expect(
			resolveConfig({ ...noAgents, agentServer: false }).agentServer,
		).toBe(false);
	});

	test("a seed's channel and a Discord place for an agent are refused", () => {
		expect(
			refusal({
				...appTeam,
				agents: [{ ...seeds[0], channelId: "900000000000000003" }],
			}),
		).toContain("config agents[0].channelId:");
		expect(
			refusal({
				...appTeam,
				routing: { agents: { guide: { primary: "discord" } } },
			}),
		).toContain("routing.agents.guide.primary");
	});

	test("with the guild, the entry channel is still required", () => {
		expect(
			refusal({
				...appTeam,
				discord: { token: "token", guild: "900000000000000001" },
			}),
		).toContain("config discord.entryChannel: required");
	});
});
