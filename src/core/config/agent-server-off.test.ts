import { describe, expect, test } from "bun:test";
import { ConfigError } from "../domain/errors.ts";
import { type RoundtableConfig, resolveConfig } from "./config.ts";

const guest: RoundtableConfig = {
	owner: { id: "100000000000000001", name: "Ada" },
	discord: { token: "token", guild: "900000000000000001" },
	agentServer: false,
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

describe("agentServer: false", () => {
	test("a Discord host needs neither an entry channel nor a public URL, and has no agent server or skills", () => {
		const config = resolveConfig(guest);
		expect(config.agentServer).toBe(false);
		expect(config.skills).toBe(false);
		expect(config.discord?.guild).toBe("900000000000000001");
		expect(config.discord?.entryChannel).toBeUndefined();
		expect(config.http).toBeUndefined();
	});

	test("the guild stays required", () => {
		const { guild: _, ...noGuild } = guest.discord as { guild: string };
		expect(refusal({ ...guest, discord: noGuild })).toContain("discord.guild");
	});

	test("a configured entry channel and public URL are still accepted", () => {
		const config = resolveConfig({
			...guest,
			discord: { ...guest.discord, entryChannel: "900000000000000002" },
			http: { publicUrl: "https://bot.example.com" },
		});
		expect(config.discord?.entryChannel).toBe("900000000000000002");
	});

	test("anything only agents use is refused, naming agentServer and the key", () => {
		const agents = [
			{ name: "librarian", displayName: "Librarian", prompt: "Read." },
		];
		const cases: [
			string,
			Partial<RoundtableConfig> | Record<string, unknown>,
		][] = [
			["agents", { agents }],
			["skills", { skills: {} }],
			[
				"discord.agentMemory",
				{ discord: { ...guest.discord, agentMemory: "owners" } },
			],
			[
				"discord.agentSpeakers",
				{ discord: { ...guest.discord, agentSpeakers: "owners" } },
			],
			[
				"discord.attachmentDownload",
				{
					discord: { ...guest.discord, attachmentDownload: { idleMs: 5_000 } },
				},
			],
			["ops.agent", { ops: { agent: "infra" } }],
		];
		for (const [key, extra] of cases) {
			const message = refusal({ ...guest, ...extra });
			expect(message).toContain("agentServer");
			expect(message).toContain(key);
		}
	});

	test("harmless leftovers are not refused: an empty agents list, skills: false, characters.skins", () => {
		expect(() =>
			resolveConfig({ ...guest, agents: [], skills: false }),
		).not.toThrow();
		expect(() =>
			resolveConfig({
				...guest,
				characters: {
					skins: [
						"#111111",
						"#222222",
						"#333333",
						"#444444",
						"#555555",
						"#666666",
					],
				},
			}),
		).not.toThrow();
	});

	test("agentServer must be false when written", () => {
		expect(refusal({ ...guest, agentServer: true })).toContain("agentServer");
		expect(refusal({ ...guest, agentServer: "no" })).toContain("agentServer");
	});
});

describe("agentServer left out", () => {
	const standard = {
		...guest,
		agentServer: undefined,
		discord: { ...guest.discord, entryChannel: "900000000000000002" },
		http: { publicUrl: "https://bot.example.com" },
	};

	test("the agent server is on, and Discord still needs its entry channel and public URL", () => {
		const config = resolveConfig(standard);
		expect(config.agentServer).toBe(true);
		expect(config.skills).toEqual({});
		expect(
			refusal({
				...standard,
				discord: { token: "t", guild: "900000000000000001" },
			}),
		).toContain("discord.entryChannel");
		expect(refusal({ ...standard, http: undefined })).toContain(
			"http.publicUrl",
		);
	});
});

describe('agentServer: { tools: "chat-only" }', () => {
	test("keeps the agent server and resolves the agents' tools to chat-only", () => {
		const config = resolveConfig({
			...guest,
			agentServer: { tools: "chat-only" },
			discord: {
				...guest.discord,
				entryChannel: "900000000000000002",
			},
			http: { publicUrl: "https://bot.example.com" },
		});
		expect(config.agentServer).toBe(true);
		expect(config.agentTools).toBe("chat-only");
	});

	test("a config without the key, or with false, keeps the full tools", () => {
		const { agentServer: _, discord: __, ...bare } = guest;
		expect(
			resolveConfig({
				...bare,
				agents: [{ name: "a", displayName: "A", prompt: "p" }],
			}).agentTools,
		).toBe("full");
		expect(resolveConfig(guest).agentTools).toBe("full");
	});

	test("anything else is refused, naming the accepted forms", () => {
		for (const bad of [true, "chat-only", { tools: "full" }, { tools: 1 }]) {
			expect(refusal({ ...guest, agentServer: bad })).toContain(
				"config agentServer",
			);
		}
		expect(refusal({ ...guest, agentServer: { tool: "chat-only" } })).toContain(
			"unknown key",
		);
	});
});
