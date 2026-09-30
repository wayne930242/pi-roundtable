import { describe, expect, test } from "bun:test";
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

describe("resolveConfig", () => {
	test("fills every default from a minimal configuration", () => {
		const config = resolveConfig(minimal);
		expect(config.name).toBe("Roundtable");
		expect(config.owner).toEqual({
			id: "100000000000000001",
			name: "Ada",
			pronouns: { subject: "they", object: "them", possessive: "their" },
		});
		expect(config.discord.rootCommand).toBe("roundtable");
		expect(config.agentDir).toBe("/data/pi");
		expect(config.model).toEqual({
			provider: "anthropic",
			id: "claude-sonnet-5-5",
		});
		expect(config.thinking).toBe("medium");
		expect(config.judge).toEqual({ model: config.model, threshold: 0.6 });
		expect(config.delegation).toEqual({
			model: config.model,
			thinking: "medium",
		});
		expect(config.locale).toBe("en");
		expect(config.timeZone).toBe("UTC");
		expect(config.http.port).toBe(3000);
		expect(config.agents).toEqual([]);
		expect(config.plugins).toEqual([]);
	});

	test("the root command follows the assistant's name unless one is given", () => {
		expect(
			resolveConfig({ ...minimal, name: "Robin Hood" }).discord.rootCommand,
		).toBe("robin-hood");
		expect(
			resolveConfig({
				...minimal,
				discord: { ...minimal.discord, rootCommand: "rh" },
			}).discord.rootCommand,
		).toBe("rh");
	});

	test("pronouns become the words prompts use", () => {
		const owner = { ...minimal.owner, pronouns: "she" as const };
		expect(resolveConfig({ ...minimal, owner }).owner.pronouns).toEqual({
			subject: "she",
			object: "her",
			possessive: "her",
		});
	});

	test("an unknown key names the nearest known key, at any depth", () => {
		expect(refused({ ...minimal, discrod: {} })).toStartWith(
			'config discrod: unknown key. Did you mean "discord"? The keys here are name, owner, discord,',
		);
		expect(
			refused({ ...minimal, discord: { ...minimal.discord, tokn: "x" } }),
		).toContain('config discord.tokn: unknown key. Did you mean "token"?');
	});

	test("a missing required key names it and the fix", () => {
		const { model: _model, ...without } = minimal;
		expect(refused(without)).toBe(
			"config model: required, expected a non-empty string. Add it to roundtable.config.ts.",
		);
		expect(refused({ ...minimal, owner: { name: "Ada" } })).toBe(
			"config owner.id: required, expected a non-empty string. Add it to roundtable.config.ts.",
		);
	});

	test("a wrong value says what was expected and what it got", () => {
		expect(refused({ ...minimal, thinking: "loud" })).toBe(
			'config thinking: expected one of off, minimal, low, medium, high, xhigh, got "loud". Fix the value in roundtable.config.ts.',
		);
		expect(
			refused({ ...minimal, http: { publicUrl: "https://x", port: 70000 } }),
		).toContain(
			"config http.port: expected an integer from 1 to 65535, got 70000.",
		);
		expect(refused({ ...minimal, model: "sonnet" })).toBe(
			'config model: expected <provider>/<id>, got "sonnet". Write it like anthropic/claude-sonnet-5-5.',
		);
		expect(refused({ ...minimal, locale: "fr" })).toContain(
			"config locale: expected a locale, en or zh-TW",
		);
		expect(refused({ ...minimal, toolTiers: { shell: "root" } })).toContain(
			"config toolTiers.shell: expected one of owner, admin, member",
		);
		expect(refused({ ...minimal, plugins: [{ name: "x" }] })).toContain(
			"config plugins[0]: expected a plugin, an object with a name and a setup function",
		);
		expect(refused("nope")).toContain("expected an object");
	});

	test("agents are seeds with their four texts", () => {
		const seed = {
			name: "coordinator",
			displayName: "Coordinator",
			prompt: "You coordinate.",
			avatarPrompt: "A calm coordinator.",
			channelId: "900000000000000002",
		};
		expect(resolveConfig({ ...minimal, agents: [seed] }).agents).toEqual([
			seed,
		]);
		expect(refused({ ...minimal, agents: [{ name: "x" }] })).toContain(
			"config agents[0].displayName: required",
		);
	});
});
