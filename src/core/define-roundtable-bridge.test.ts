import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoundtableConfig } from "./config/config.ts";
import { defineRoundtable } from "./define-roundtable.ts";
import { silentLogger } from "./log.ts";
import type { RoundtablePlugin } from "./plugin.ts";
import { useTestLocale } from "./testing/locale.ts";

const dataDir = mkdtempSync(join(tmpdir(), "roundtable-define-bridge-"));

const discord = {
	token: "token",
	guild: "900000000000000001",
	entryChannel: "900000000000000002",
};

const config: RoundtableConfig = {
	owner: { id: "100000000000000001", name: "Ada" },
	discord,
	database: { url: "postgres://localhost/roundtable" },
	dataDir,
	model: "anthropic/claude-sonnet-5-5",
	http: { publicUrl: "https://bot.example.com", port: 3456 },
};

// Other suites read the text through the catalog; leave it as the tests expect.
afterEach(() => useTestLocale());

describe("claude-bridge in a host whose shared conversations several people speak in", () => {
	const BRIDGE = "claude-bridge/claude-opus-5-5";
	/** One owner, whose remote MCP token is theirs, on claude-bridge with memory. */
	const remote: RoundtablePlugin = {
		name: "remote",
		identities: [{ identity: "token:remote" }],
		setup: () => ({}),
	};

	test("boots with a warning that says why shared bridge history remains risky", async () => {
		const warnings: string[] = [];
		const logger = {
			...silentLogger(),
			warn: (_fields: object | string, message?: string) =>
				void warnings.push(message ?? ""),
		};
		const refusal = defineRoundtable(
			{
				...config,
				model: BRIDGE,
				speakers: { members: { everyone: true } },
			},
			{ logger },
		);
		await expect(refusal).resolves.toBeDefined();
		expect(warnings.join(" ")).toMatch(
			/claude-bridge.*access\.members.*private memory/s,
		);
	});

	test("counts a second owner, and a plugin's identity bound to someone else, as more than one speaker", async () => {
		await expect(
			defineRoundtable({
				...config,
				owner: undefined,
				access: {
					owners: [
						{ name: "Ada", principal: "ada", identities: ["discord:1"] },
						{ name: "Bo", identities: ["discord:2"] },
					],
				},
				model: BRIDGE,
			}),
		).resolves.toBeDefined();
		await expect(
			defineRoundtable({
				...config,
				model: BRIDGE,
				plugins: [
					{
						name: "kiosk",
						identities: [{ identity: "token:kiosk", principal: "p_kiosk" }],
						setup: () => ({}),
					},
				],
			}),
		).resolves.toBeDefined();
	});

	test("does not count the owner's own identity listed again under admins or members, but counts anyone listed beside it", async () => {
		const owner = {
			name: "Ann",
			principal: "ann",
			identities: ["discord:ann"],
		};
		await expect(
			defineRoundtable({
				...config,
				owner: undefined,
				access: {
					owners: [owner],
					admins: { identities: ["discord:ann"] },
					members: { identities: ["discord:ann"] },
				},
				model: BRIDGE,
			}),
		).resolves.toBeDefined();
		await expect(
			defineRoundtable({
				...config,
				owner: undefined,
				access: {
					owners: [owner],
					members: { identities: ["discord:ann", "discord:bo"] },
				},
				model: BRIDGE,
			}),
		).resolves.toBeDefined();
	});

	test("a single owner's host on claude-bridge still boots, and so does a crowd without memory or on another provider", async () => {
		await expect(
			defineRoundtable({ ...config, model: BRIDGE, plugins: [remote] }),
		).resolves.toBeDefined();
		await expect(
			defineRoundtable({
				...config,
				model: BRIDGE,
				memory: false,
				speakers: { members: { everyone: true } },
			}),
		).resolves.toBeDefined();
		await expect(
			defineRoundtable({
				...config,
				speakers: { members: { everyone: true } },
			}),
		).resolves.toBeDefined();
	});
});
