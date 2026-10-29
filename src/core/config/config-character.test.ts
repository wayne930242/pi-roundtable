import { describe, expect, test } from "bun:test";
import { CATALOG, EAST_ASIAN_SKINS } from "../../characters/index.ts";
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

describe("characters.skins", () => {
	test("is the package's own six when left out, and the host's six when given", () => {
		expect(resolveConfig(minimal).characters.skins).toEqual(CATALOG.skins);
		expect(
			resolveConfig({ ...minimal, characters: {} }).characters.skins,
		).toEqual(CATALOG.skins);
		expect(
			resolveConfig({ ...minimal, characters: { skins: EAST_ASIAN_SKINS } })
				.characters.skins,
		).toEqual([...EAST_ASIAN_SKINS]);
	});

	test("must be exactly six #rrggbb colors, and the error names the key and the fix", () => {
		const five = [...EAST_ASIAN_SKINS].slice(0, 5);
		const six = [...EAST_ASIAN_SKINS];
		for (const bad of [five, [...six, "#ffffff"], "#ffffff", []]) {
			const message = refused({ ...minimal, characters: { skins: bad } });
			expect(message).toContain("config characters.skins");
			expect(message).toContain("exactly 6");
			expect(message).toContain("roundtable.config.ts");
		}
		const badSix = [...six.slice(0, 3), "peach", ...six.slice(4)];
		expect(refused({ ...minimal, characters: { skins: badSix } })).toContain(
			"config characters.skins[3]",
		);
		expect(
			refused({ ...minimal, characters: { skins: new Array(6) } }),
		).toContain("config characters.skins[0]");
		expect(refused({ ...minimal, characters: { skinTones: six } })).toContain(
			"config characters.skinTones: unknown key",
		);
	});
});
