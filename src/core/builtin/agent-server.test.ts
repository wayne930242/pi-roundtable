import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentRuntime, RuntimeDeps } from "../contract/runtime.ts";
import { PluginError } from "../errors.ts";
import { silentLogger } from "../log.ts";
import type {
	LinkedSessions,
	PluginContext,
	RoundtablePlugin,
} from "../plugin.ts";
import {
	collectContributions,
	linkSessions,
} from "../registry/contributions.ts";
import { resolveProviders } from "../registry/providers.ts";
import { ServiceRegistry } from "../registry/services.ts";
import { PiAgentRuntime } from "../runtime/pi-agent-runtime.ts";
import {
	AGENTS,
	BACKGROUND_TURNS,
	type BackgroundTurns,
	SCHEDULES,
	type ScheduleStore,
} from "../services.ts";
import { speakerPolicy } from "../speakers.ts";
import { toolTiers } from "../tool-tiers.ts";
import {
	type AgentServerOptions,
	type AgentServerStores,
	agentServerPlugin,
} from "./agent-server.ts";
import { DISCORD, type DiscordServices } from "./discord.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function options(extra: Partial<AgentServerOptions> = {}): AgentServerOptions {
	const dir = mkdtempSync(join(tmpdir(), "agent-server-"));
	dirs.push(dir);
	return {
		guildId: "g1",
		entryChannelId: "c1",
		owner: {
			id: "1",
			name: "Owner",
			pronouns: { subject: "they", object: "them", possessive: "their" },
		},
		assistant: "Assistant",
		speakers: speakerPolicy({ owners: ["1"] }),
		// SAFETY: building the runtime reads nothing of the model runtime; a turn would.
		modelRuntime: {} as ModelRuntime,
		agentDir: join(dir, "agent"),
		dataDir: join(dir, "data"),
		model: { provider: "test", id: "model" },
		thinking: "low",
		judgeThreshold: 0.6,
		workDir: join(dir, "work"),
		shellUser: "tester",
		prompts: { shared: "shared" },
		avatarListener: "public",
		avatarUrl: "https://example.com",
		avatarReference: join(import.meta.dir, "..", "assets", "neutral.png"),
		...extra,
	};
}

const held = { loads: [] as string[] };
// SAFETY: setup hands the stores to the team and registry, which read them only when a turn or a command runs.
const stores = {
	agents: {},
	confirmations: {
		load: async (key: string) => void held.loads.push(key),
		save: async () => undefined,
	},
} as unknown as AgentServerStores;

/** The agent server set up over stand-in stores and Discord, as far as setup reads them. */
async function setUp(
	plugin: RoundtablePlugin,
	filling: RoundtablePlugin[] = [],
	personas: Record<string, string> = {},
) {
	const plugins = [...filling, plugin];
	const services = new ServiceRegistry([...plugins]);
	// What the plugins before the agent server provide: the schedule store, background turns and Discord.
	// SAFETY: setup hands them to the team and registry, which read them only when a turn or a command runs.
	services.preset(SCHEDULES, {} as ScheduleStore);
	services.preset(BACKGROUND_TURNS, {} as BackgroundTurns);
	// SAFETY: as above.
	services.preset(DISCORD, {
		connection: {
			agentChannels: () => ({}),
			agentDashboard: () => ({}),
			onChannelDeleted: () => undefined,
		},
		commands: { add: () => undefined },
		threads: {},
		guard: {},
	} as unknown as DiscordServices);
	let linked: LinkedSessions | undefined;
	const seen: { deps?: RuntimeDeps } = {};
	const context = {
		logger: silentLogger(),
		env: { locale: "en", timeZone: "UTC", now: () => new Date() },
		sessions: () => {
			if (!linked) throw new Error("not linked");
			return {
				...linked,
				persona: (kind: string) => personas[kind] ?? linked?.persona(kind),
			};
		},
		queue: {},
		toolTiers: toolTiers(),
		events: {},
		conversations: {},
		surfaces: {
			prompts: () => undefined,
			react: async () => undefined,
			startTyping: () => () => undefined,
			showStop: () => () => undefined,
			sendReply: async () => undefined,
		},
		turns: {},
		database: () => {
			throw new PluginError("no database");
		},
		providers: resolveProviders(plugins),
		dashboard: () => [],
	} as unknown as Omit<PluginContext, "services">;
	const registry = await collectContributions(
		plugins,
		context,
		toolTiers(),
		services,
	);
	linked = linkSessions(registry);
	return { services, registry, context, linked, seen };
}

describe("the agent server's runtime", () => {
	test("is the Pi runtime when no plugin fills the runtime slot", async () => {
		const { services } = await setUp(
			agentServerPlugin(options(), async () => stores),
		);
		expect(services.get(AGENTS).runtime).toBeInstanceOf(PiAgentRuntime);
	});

	test("is the runtime of the plugin that fills the slot, built once from the deps the server hands it", async () => {
		let built = 0;
		let deps: RuntimeDeps | undefined;
		const runtime = { name: "echo" } as unknown as AgentRuntime;
		const echo: RoundtablePlugin = {
			name: "echo",
			providers: {
				runtime: (given) => {
					built += 1;
					deps = given;
					return runtime;
				},
			},
			setup: () => ({}),
		};
		const { services } = await setUp(
			agentServerPlugin(options(), async () => stores),
			[echo],
		);
		expect(services.get(AGENTS).runtime).toBe(runtime);
		expect(built).toBe(1);
		const given = deps;
		if (!given) throw new Error("the factory was not called");
		expect(given.owner).toEqual({ id: "1", name: "Owner" });
		expect(given.env.timeZone).toBe("UTC");
		expect(given.agents.workDir).toContain("work");
		expect(typeof given.sessions).toBe("function");
		expect(typeof given.prompts).toBe("function");
		expect(typeof given.judge.askYesNo).toBe("function");
		expect(given.toolTiers).toBeDefined();
		// Held actions go to the host's store, and the speaker's conversation key is passed through.
		expect(await given.confirmations.load("discord:1")).toBeUndefined();
	});

	test("the server's preflight and its runtime service call the provider's preflight and dispose", async () => {
		const calls: string[] = [];
		const runtime: AgentRuntime = {
			runTurn: async () => ({ ok: true, text: "" }),
			steer: async () => false,
			stop: () => false,
			startFresh: async () => undefined,
			deleteConversation: async () => undefined,
			pendingConfirmation: () => undefined,
			heldActions: async () => undefined,
			recentTranscript: async () => [],
			preflight: async () => void calls.push("preflight"),
			dispose: () => void calls.push("dispose"),
		};
		const echo: RoundtablePlugin = {
			name: "echo",
			providers: { runtime: () => runtime },
			setup: () => ({}),
		};
		const server = agentServerPlugin(options(), async () => stores);
		const { registry } = await setUp(server, [echo]);
		await server.preflight?.();
		const service = registry.services.find((s) => s.name === "runtime");
		await service?.stop?.();
		expect(calls).toEqual(["preflight", "dispose"]);
	});

	test("a runtime without preflight or dispose is left alone by them", async () => {
		const runtime = {
			stop: () => false,
		} as unknown as AgentRuntime;
		const echo: RoundtablePlugin = {
			name: "echo",
			providers: { runtime: () => runtime },
			setup: () => ({}),
		};
		const server = agentServerPlugin(options(), async () => stores);
		const { registry } = await setUp(server, [echo]);
		await server.preflight?.();
		const service = registry.services.find((s) => s.name === "runtime");
		await service?.stop?.();
	});
});

describe("the agents' pictures", () => {
	test("are drawn only when a plugin fills the images slot, and the server publishes the studio", async () => {
		const plain = await setUp(agentServerPlugin(options(), async () => stores));
		expect(plain.services.get(AGENTS).avatars.canDraw).toBe(false);
		const images: RoundtablePlugin = {
			name: "codex-images",
			providers: { images: async () => new Uint8Array() },
			setup: () => ({}),
		};
		const drawing = await setUp(
			agentServerPlugin(options(), async () => stores),
			[images],
		);
		expect(drawing.services.get(AGENTS).avatars.canDraw).toBe(true);
	});

	test("are served on the listener the server names", async () => {
		const { registry } = await setUp(
			agentServerPlugin(options({ avatarListener: "web" }), async () => stores),
		);
		expect(registry.routes.map((route) => route.listener)).toEqual(["web"]);
	});
});
