import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	defineRoundtable,
	Roundtable,
	type RoundtablePlugin,
} from "pi-roundtable";
import { DISCORD, type DiscordServices } from "pi-roundtable/discord";
import { fakeDiscord, silentLogger } from "pi-roundtable/testing";
import { CONNECTORS, mcpConnectors, REMOTE_MCP, remoteMcp } from "./index.ts";

// `Roundtable.check()` sets every plugin up without a database or the network: a plugin that reads
// the database or ContextForge in setup fails it. Both plugins do that work as the host starts.

const dir = mkdtempSync(join(tmpdir(), "roundtable-mcp-check-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A Discord that connects to nothing, standing in for the built-in plugin that does. */
const quietDiscord: RoundtablePlugin = {
	name: "quiet-discord",
	provides: [DISCORD],
	replaces: [DISCORD],
	setup: ({ services }) => {
		const discord = fakeDiscord();
		// SAFETY: the built-in plugins after it hand these to the team and the tools, which read them only when a turn or a command runs.
		services.provide(DISCORD, {
			...discord.service.given,
			connection: {
				agentChannels: () => ({}),
				agentDashboard: () => ({ show: async () => undefined }),
				onChannelDeleted: () => undefined,
				ownerChannel: async () => "discord:owner",
				ownerOperations: () => ({}),
			},
			threads: { open: async () => undefined, sweep: async () => undefined },
		} as unknown as DiscordServices);
		return {
			surfaces: [
				{
					surface: "discord",
					start: async () => undefined,
					sendReply: async () => undefined,
				},
			],
		};
	},
};

/** A runtime that answers nothing, so the agent server builds no Pi session. */
const quietRuntime: RoundtablePlugin = {
	name: "quiet-runtime",
	providers: {
		runtime: () => ({
			runTurn: async () => ({ ok: true, text: "" }),
			steer: async () => false,
			stop: () => false,
			startFresh: async () => undefined,
			deleteConversation: async () => undefined,
			pendingConfirmation: () => undefined,
			heldActions: async () => undefined,
			recentTranscript: async () => [],
		}),
	},
	setup: () => ({}),
};

async function check(...plugins: RoundtablePlugin[]) {
	const { options, plugins: defined } = await defineRoundtable(
		{
			owner: { id: "100000000000000001", name: "Ada" },
			// An address nothing listens on: the check never connects.
			database: { url: "postgres://unused@127.0.0.1:1/none" },
			dataDir: dir,
			agentDir: join(dir, "agent"),
			model: "anthropic/claude-sonnet-5-5",
			http: {
				publicUrl: "https://bot.example.test",
				socketPath: join(dir, "public.sock"),
			},
			discord: {
				token: "token",
				guild: "900000000000000001",
				entryChannel: "900000000000000002",
			},
			plugins: [quietDiscord, quietRuntime, ...plugins],
		},
		{ logger: silentLogger() },
	);
	return new Roundtable(options, defined).check();
}

test("mcp-connectors sets up without reading the database or ContextForge", async () => {
	const report = await check(
		mcpConnectors({
			// An address nothing listens on: resolving a server would fail the check.
			contextForge: {
				url: "http://127.0.0.1:1",
				jwtSecret: "secret",
				user: "admin@example.com",
			},
		}),
	);
	expect(report.plugins).toContain("mcp-connectors");
	expect(report.services).toContain("connectors");
	expect(CONNECTORS.id).toBeString();
});

test("remote-mcp sets up without reading the stored principals", async () => {
	const report = await check(
		remoteMcp({
			dispatchToken: "dispatch-token-for-tests",
			publicUrl: "https://bot.example.test",
		}),
	);
	expect(report.plugins).toContain("remote-mcp");
	expect(report.services).toEqual(
		expect.arrayContaining(["remote-principal", "remote-sweeper"]),
	);
	expect(report.routes.some((route) => route.includes("/mcp/"))).toBe(true);
	expect(REMOTE_MCP.id).toBeString();
});
