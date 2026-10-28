import { describe, expect, test } from "bun:test";
import type { AgentSeed } from "../agents/agent-rules.ts";
import { ConfigError } from "../domain/errors.ts";
import { type RoundtableConfig, resolveConfig } from "./config.ts";

const minimal: RoundtableConfig = {
	owner: { id: "100000000000000001", name: "Ada" },
	discord: {
		token: "token",
		guild: "900000000000000001",
		entryChannel: "900000000000000002",
	},
	database: { url: "postgres://localhost/roundtable" },
	dataDir: "/data",
	model: "anthropic/claude-sonnet-5-5",
	http: { publicUrl: "https://bot.example.com" },
};

const refused = (input: unknown): string => {
	try {
		resolveConfig(input);
	} catch (error) {
		if (error instanceof ConfigError) return error.message;
		throw error;
	}
	return "";
};

describe("agent seeds' characters", () => {
	test("a seed's character is checked as resolveCharacter does, and avatarPrompt is optional", () => {
		const base = { name: "rev", displayName: "Rev", prompt: "You review." };
		const dressed: AgentSeed = {
			...base,
			character: { class: "knight", palette: "vert" },
		};
		expect(resolveConfig({ ...minimal, agents: [dressed] }).agents).toEqual([
			dressed,
		]);
		// A look without a class is a fragment over the role's suggestion.
		expect(
			resolveConfig({
				...minimal,
				agents: [{ ...base, character: { palette: "rose" } }],
			}).agents,
		).toHaveLength(1);
		expect(
			refused({
				...minimal,
				agents: [{ ...base, character: { class: "knight", hat: "crown" } }],
			}),
		).toContain("config agents[0].character.hat");
		expect(
			refused({
				...minimal,
				agents: [{ ...base, character: { class: "dragon" } }],
			}),
		).toContain("config agents[0].character.class");
	});
});
