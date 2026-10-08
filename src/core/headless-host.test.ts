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
			speaker: { id: "2", name: "Bo", tier: "member", principalId: "2" },
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

	test("its sessions have no Discord tools, no shell, no schedule or delegation tools, and no notify, with no direct channel to send to", async () => {
		const host = await testHost({ discord: false });
		hosts.push(host);
		const tools = (await host.sessionTools()).flatMap((entry) => entry.tools);
		expect(tools).toContain("memory_add");
		expect(tools.filter((tool) => tool.startsWith("discord_"))).toEqual([]);
		// No plugin contributes the owner's background target, so no schedule or delegated run could start.
		for (const absent of [
			"schedule_create",
			"schedule_list",
			"delegate_task",
			"notify",
			"notify_owner",
			"bash",
			"read",
			"edit",
			"write",
		])
			expect(tools).not.toContain(absent);
	});

	/** A host on Pi's runtime, with no Discord, the probe, and `plugins`; the probe keeps its context. */
	async function piHost(plugins: RoundtablePlugin[] = []) {
		const dataDir = mkdtempSync(join(tmpdir(), "roundtable-headless-"));
		const seen: { context?: PluginContext } = {};
		const probe: RoundtablePlugin = {
			name: "probe",
			setup: (given) => {
				seen.context = given;
				return { services: [{ name: "probe" }] };
			},
		};
		const modelRuntime = await ModelRuntime.create({
			authPath: join(dataDir, "auth.json"),
			modelsPath: join(dataDir, "models.json"),
		});
		// The preflight builds a session, which needs a key; no request is made with it.
		await modelRuntime.setRuntimeApiKey("anthropic", "test-key");
		const defined = await defineRoundtable(
			{
				owner: { id: "100000000000000001", name: "Ada" },
				database: { url: testDatabaseUrl },
				dataDir,
				model: "anthropic/claude-sonnet-5-5",
				plugins: [probe, ...plugins],
			},
			{ logger: silentLogger(), modelRuntime },
		);
		expect(defined.plugins.map((plugin) => plugin.name)).not.toContain(
			"discord",
		);
		roundtable = new Roundtable(defined.options, defined.plugins);
		return { roundtable, seen };
	}

	test("without a runtime provider the runtime plugin builds Pi, reading no Discord", async () => {
		const host = await piHost();
		// Every plugin is set up before the preflight, which then refuses: no plugin loads the
		// package that registers the compaction tool Pi's runtime requires, and it says which.
		const boot = host.roundtable.run();
		await expect(boot).rejects.toThrow(
			"required tools are not registered: compact_session",
		);
		await expect(boot).rejects.toThrow('piPackages: ["pi-self-compact"]');
		roundtable = undefined;
		expect(host.seen.context?.services.get(RUNTIME)).toBeInstanceOf(
			PiAgentRuntime,
		);
		expect(host.seen.context?.services.find(DISCORD)).toBeUndefined();
	});

	test("with pi-self-compact loaded, as a fresh project loads it, Pi's runtime passes the preflight and the host starts", async () => {
		const host = await piHost([
			{
				name: "self-compact",
				setup: () => ({ piPackages: ["pi-self-compact"] }),
			},
		]);
		await host.roundtable.run();
		expect(host.seen.context?.services.get(RUNTIME)).toBeInstanceOf(
			PiAgentRuntime,
		);
	});
});
