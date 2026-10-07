import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { DISCORD } from "./builtin/discord.ts";
import type { AgentRuntime } from "./contract/runtime.ts";
import type { ChatSurface } from "./contract/surface.ts";
import { defineRoundtable } from "./define-roundtable.ts";
import { Roundtable } from "./host.ts";
import { silentLogger } from "./log.ts";
import type { PluginContext, RoundtablePlugin } from "./plugin.ts";
import { PiAgentRuntime } from "./runtime/pi-agent-runtime.ts";
import { AGENTS, CONVERSATIONS, RUNTIME } from "./services.ts";
import { describeDb, testDatabaseUrl } from "./testing/database.ts";
import { hasWebAccess, type TestHost, testHost } from "./testing/test-host.ts";

const hosts: TestHost[] = [];
let roundtable: Roundtable | undefined;
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.stop();
	await roundtable?.shutdown("test");
	roundtable = undefined;
});

/** A runtime that answers each turn with its text. */
const echo: AgentRuntime = {
	runTurn: async (request) => ({ ok: true, text: `echo ${request.text}` }),
	steer: async () => false,
	stop: () => false,
	startFresh: async () => undefined,
	deleteConversation: async () => undefined,
	pendingConfirmation: () => undefined,
	heldActions: async () => undefined,
	recentTranscript: async () => [],
};

/** A surface of the `test:` channels, recording what it is sent. */
function recordingSurface(replies: string[]): RoundtablePlugin {
	const surface: ChatSurface = {
		surface: "test",
		start: async () => undefined,
		sendReply: async (_channel, reply) =>
			void replies.push(reply.chunks.join()),
	};
	return { name: "test-surface", setup: () => ({ surfaces: [surface] }) };
}

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set and the delegation worker can load.
(hasWebAccess() ? describeDb : describe.skip)("a host without Discord", () => {
	test("boots without Discord or the agent server and runs turns on the runtime", async () => {
		const replies: string[] = [];
		const host = await testHost({
			discord: false,
			runtime: echo,
			plugins: [recordingSurface(replies)],
		});
		hosts.push(host);
		const { services, turns } = host.context;
		expect(services.get(RUNTIME)).toBe(echo);
		expect(services.find(DISCORD)).toBeUndefined();
		expect(services.find(AGENTS)).toBeUndefined();
		const result = await turns.run({
			channel: "test:room",
			kind: "study",
			text: "hello",
			speaker: { id: "2", name: "Bo", tier: "member" },
		});
		expect(result).toEqual({ ok: true, text: "echo hello" });
		expect(replies).toEqual(["echo hello"]);
		// The turn recorded its conversation in the host's registry.
		expect(await services.get(CONVERSATIONS).get("test:room")).toMatchObject({
			key: "test:room",
			surface: "test",
			kind: "study",
			visibility: "shared",
		});
	});

	test("its sessions have no Discord tools, no shell, and no tool that messages the owner on Discord", async () => {
		const host = await testHost({ discord: false });
		hosts.push(host);
		const tools = (await host.sessionTools()).flatMap((entry) => entry.tools);
		expect(tools).toContain("schedule_create");
		expect(tools).toContain("memory_add");
		expect(tools.filter((tool) => tool.startsWith("discord_"))).toEqual([]);
		for (const absent of ["notify_owner", "bash", "read", "edit", "write"])
			expect(tools).not.toContain(absent);
	});

	test("without a runtime provider the runtime plugin builds Pi, reading no Discord", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "roundtable-headless-"));
		let context: PluginContext | undefined;
		const probe: RoundtablePlugin = {
			name: "probe",
			setup: (given) => {
				context = given;
				return { services: [{ name: "probe" }] };
			},
		};
		const modelRuntime = await ModelRuntime.create({
			authPath: join(dataDir, "auth.json"),
			modelsPath: join(dataDir, "models.json"),
		});
		// The preflight builds a session, which needs a key; no request is made with it.
		await modelRuntime.setRuntimeApiKey("anthropic", "test-key");
		const { options, plugins } = await defineRoundtable(
			{
				owner: { id: "100000000000000001", name: "Ada" },
				database: { url: testDatabaseUrl },
				dataDir,
				model: "anthropic/claude-sonnet-5-5",
				plugins: [probe],
			},
			{ logger: silentLogger(), modelRuntime },
		);
		expect(plugins.map((plugin) => plugin.name)).not.toContain("discord");
		roundtable = new Roundtable(options, plugins);
		// Every plugin is set up before the preflight, which then refuses: a fresh agent dir has no
		// package that registers the compaction tool Pi's runtime requires.
		await expect(roundtable.run()).rejects.toThrow(
			"required tools are not registered: compact_session",
		);
		roundtable = undefined;
		expect(context?.services.get(RUNTIME)).toBeInstanceOf(PiAgentRuntime);
		expect(context?.services.find(DISCORD)).toBeUndefined();
	});
});
