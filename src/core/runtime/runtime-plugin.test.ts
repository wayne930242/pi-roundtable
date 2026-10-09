import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
	AgentRuntime,
	AgentSessions,
	HeldActionStore,
	RuntimeDeps,
} from "../contract/runtime.ts";
import { PluginError } from "../errors.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import type { Principal } from "../identity/principal-store.ts";
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
import { IDENTITY, RUNTIME } from "../services.ts";
import type { Speaker } from "../speakers.ts";
import { toolTiers } from "../tool-tiers.ts";
import { PiAgentRuntime } from "./pi-agent-runtime.ts";
import {
	agentSessionsSlot,
	RUNTIME_PLUGIN,
	type RuntimePluginOptions,
	runtimePlugin,
} from "./runtime-plugin.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function options(
	extra: Partial<RuntimePluginOptions> = {},
): RuntimePluginOptions {
	const dir = mkdtempSync(join(tmpdir(), "runtime-plugin-"));
	dirs.push(dir);
	return {
		owner: {
			id: "1",
			name: "Owner",
			pronouns: { subject: "they", object: "them", possessive: "their" },
		},
		// SAFETY: building the runtime reads nothing of the model runtime; a turn would.
		modelRuntime: {} as ModelRuntime,
		agentDir: join(dir, "agent"),
		dataDir: join(dir, "data"),
		model: { provider: "test", id: "model" },
		thinking: "low",
		judgeThreshold: 0.6,
		...extra,
	};
}

const loads: string[] = [];
const heldActions: HeldActionStore = {
	load: async (key) => void loads.push(key),
	save: async () => undefined,
};

/** The runtime plugin set up alone, over stand-in held actions, as far as setup reads them. */
async function setUp(
	plugin: RoundtablePlugin,
	filling: RoundtablePlugin[] = [],
) {
	const plugins = [...filling, plugin];
	const services = new ServiceRegistry([...plugins]);
	let linked: LinkedSessions | undefined;
	const context = {
		logger: silentLogger(),
		env: { locale: "en", timeZone: "UTC", now: () => new Date() },
		sessions: () => {
			if (!linked) throw new Error("not linked");
			return linked;
		},
		queue: {},
		toolTiers: toolTiers(),
		events: {},
		conversations: {},
		surfaces: { prompts: () => undefined },
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
	return { services, registry };
}

const quiet: AgentRuntime = {
	runTurn: async () => ({ ok: true, text: "" }),
	steer: async () => false,
	stop: () => false,
	startFresh: async () => undefined,
	deleteConversation: async () => undefined,
	pendingConfirmation: () => undefined,
	heldActions: async () => undefined,
	recentTranscript: async () => [],
};

describe("the runtime plugin", () => {
	test("is named runtime, migrates the held actions, and provides the runtime", () => {
		const plugin = runtimePlugin(options());
		expect(plugin.name).toBe(RUNTIME_PLUGIN);
		expect(RUNTIME_PLUGIN).toBe("runtime");
		expect(plugin.migrations?.map((m) => m.name)).toEqual([
			"held-actions",
			"held-actions-speaker",
			"held-actions-speaker-hold",
			"held-actions-principal",
		]);
		expect(plugin.provides?.map((key) => key.id)).toEqual([
			"roundtable.runtime",
		]);
	});

	test("builds the Pi runtime when no plugin fills the runtime slot", async () => {
		const { services } = await setUp(
			runtimePlugin(options(), async () => heldActions),
		);
		expect(services.get(RUNTIME)).toBeInstanceOf(PiAgentRuntime);
	});

	test("builds the filling plugin's runtime once, from deps that know no agents without the agent server", async () => {
		let built = 0;
		let deps: RuntimeDeps | undefined;
		const echo: RoundtablePlugin = {
			name: "echo",
			providers: {
				runtime: (given) => {
					built += 1;
					deps = given;
					return quiet;
				},
			},
			setup: () => ({}),
		};
		const { services } = await setUp(
			runtimePlugin(options(), async () => heldActions),
			[echo],
		);
		expect(services.get(RUNTIME)).toBe(quiet);
		expect(built).toBe(1);
		const given = deps;
		if (!given) throw new Error("the factory was not called");
		expect(given.owner).toEqual({ id: "1", name: "Owner" });
		expect(given.env.timeZone).toBe("UTC");
		expect(given.agents).toBeUndefined();
		expect(typeof given.sessions).toBe("function");
		expect(typeof given.prompts).toBe("function");
		expect(typeof given.judge.askYesNo).toBe("function");
		expect(given.toolTiers).toBeDefined();
		expect(await given.confirmations.load("web:1")).toBeUndefined();
		expect(loads).toContain("web:1");
	});

	test("the deps read the agent server's sessions once it binds them", async () => {
		let deps: RuntimeDeps | undefined;
		const echo: RoundtablePlugin = {
			name: "echo",
			providers: {
				runtime: (given) => {
					deps = given;
					return quiet;
				},
			},
			setup: () => ({}),
		};
		const slot = agentSessionsSlot();
		await setUp(
			runtimePlugin(options({ agents: slot }), async () => heldActions),
			[echo],
		);
		expect(deps?.agents).toBeUndefined();
		const sessions: AgentSessions = {
			workDir: "/work",
			skills: () => [],
			modelOf: () => ({ model: "test/model", thinking: "off" }),
			turnChannel: (scope) => scope.home,
		};
		slot.bind(sessions);
		expect(deps?.agents).toBe(sessions);
		expect(() => slot.bind(sessions)).toThrow("bound once");
	});

	test("its preflight and its runtime service run the runtime's preflight and dispose", async () => {
		const calls: string[] = [];
		const runtime: AgentRuntime = {
			...quiet,
			preflight: async () => void calls.push("preflight"),
			dispose: () => void calls.push("dispose"),
		};
		const echo: RoundtablePlugin = {
			name: "echo",
			providers: { runtime: () => runtime },
			setup: () => ({}),
		};
		const plugin = runtimePlugin(options(), async () => heldActions);
		const { registry } = await setUp(plugin, [echo]);
		await plugin.preflight?.();
		const service = registry.services.find((s) => s.name === "runtime");
		await service?.stop?.();
		expect(calls).toEqual(["preflight", "dispose"]);
	});

	test("a runtime without preflight or dispose is left alone by them", async () => {
		const runtime = { stop: () => false } as unknown as AgentRuntime;
		const echo: RoundtablePlugin = {
			name: "echo",
			providers: { runtime: () => runtime },
			setup: () => ({}),
		};
		const plugin = runtimePlugin(options(), async () => heldActions);
		const { registry } = await setUp(plugin, [echo]);
		await plugin.preflight?.();
		const service = registry.services.find((s) => s.name === "runtime");
		await service?.stop?.();
	});
});

describe("the runtime plugin's preflight of claude-bridge with memory", () => {
	const person = (id: string) => ({ id }) as Principal;
	/** The identity service of a host whose stored roles are these: each principal's tier, and the owners. */
	function identity(tiers: Record<string, "owner" | "admin" | "member">) {
		const service = {
			list: async () => Object.keys(tiers).map(person),
			tierOf: async (id: string) => tiers[id],
			owners: async () =>
				Object.entries(tiers)
					.filter(([, tier]) => tier === "owner")
					.map(([id]) => person(id)),
		} as unknown as IdentityService;
		return {
			name: "identity",
			provides: [IDENTITY],
			setup: ({ services }) => {
				services.provide(IDENTITY, service);
				return {};
			},
		} satisfies RoundtablePlugin;
	}
	const echo: RoundtablePlugin = {
		name: "echo",
		providers: { runtime: () => quiet },
		setup: () => ({}),
	};
	const bridge = { provider: "claude-bridge", id: "claude-opus-5-5" };

	test("warns without stopping boot when stored roles admit someone besides the owner", async () => {
		for (const tiers of [
			{ "1": "owner", p_bo: "owner" },
			{ "1": "owner", p_bo: "member" },
		] as const) {
			const plugin = runtimePlugin(
				options({ model: bridge, memory: true }),
				async () => heldActions,
			);
			await setUp(plugin, [identity(tiers), echo]);
			const preflight = plugin.preflight?.();
			await preflight;
		}
	});

	test("admitted guests and newly granted roles do not refuse turns without private history", async () => {
		const dir = mkdtempSync(join(tmpdir(), "runtime-plugin-bridge-"));
		dirs.push(dir);
		// A faux model under claude-bridge's provider id, so the guard sees the host run on it.
		const core = createFauxCore({
			provider: "claude-bridge",
			models: [{ id: "faux-1" }],
		});
		let asked = 0;
		core.setResponses(
			Array.from({ length: 4 }, () => () => {
				asked += 1;
				return fauxAssistantMessage("OK.");
			}),
		);
		const modelRuntime = await ModelRuntime.create({
			authPath: join(dir, "auth.json"),
			modelsPath: null,
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		modelRuntime.registerProvider("claude-bridge", {
			api: core.api,
			apiKey: "test",
			baseUrl: "http://faux.invalid",
			streamSimple: core.streamSimple,
			models: [
				{
					id: "faux-1",
					name: "Faux",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 100_000,
					maxTokens: 1_000,
				},
			],
		});
		const tiers: Record<string, "owner" | "admin" | "member"> = {
			"1": "owner",
		};
		const plugin = runtimePlugin(
			options({
				model: { provider: "claude-bridge", id: "faux-1" },
				memory: true,
				modelRuntime,
				thinking: "off",
			}),
			async () => heldActions,
		);
		// The compaction tool every session requires, as pi-self-compact registers it.
		const compact: RoundtablePlugin = {
			name: "compact",
			setup: () => ({
				sessionTools: [
					{
						name: "compact",
						phase: "tools",
						snapshot: () => ({
							revision: 0,
							factory: () => (pi) =>
								pi.registerTool({
									name: "compact_session",
									label: "compact_session",
									description: "Compact the session.",
									parameters: Type.Object({}),
									execute: async () => {
										throw new Error("not scripted");
									},
								}),
						}),
					},
				],
			}),
		};
		const { services } = await setUp(plugin, [identity(tiers), compact]);
		await plugin.preflight?.();
		const runtime = services.get(RUNTIME);
		const turn = (speaker: Speaker) =>
			runtime.runTurn({
				channel: "fake:room",
				kind: "owner",
				text: "Hello.",
				speaker,
				selection: { id: "chat", tools: [], groups: [] },
			});
		const owner: Speaker = {
			id: "1",
			name: "Owner",
			tier: "owner",
			principalId: "1",
		};
		const bo: Speaker = {
			id: "bo-1",
			name: "Bo",
			tier: "member",
			principalId: "p_bo",
		};
		try {
			expect((await turn(owner)).ok).toBe(true);
			expect(asked).toBe(1);
			// `roundtable principal grant` gives Bo a lasting role while the host runs.
			tiers.p_bo = "member";
			expect((await turn(bo)).ok).toBe(true);
			expect(asked).toBe(2);
			expect((await turn(owner)).ok).toBe(true);
			expect(asked).toBe(3);
		} finally {
			runtime.dispose?.();
		}
	});

	test("boots for the owner alone, without memory, or on another provider", async () => {
		const crowd = { "1": "owner", p_bo: "member" } as const;
		for (const [tiers, extra] of [
			[{ "1": "owner" }, { model: bridge, memory: true }],
			[crowd, { model: bridge, memory: false }],
			[crowd, { memory: true }],
		] as const) {
			const plugin = runtimePlugin(options(extra), async () => heldActions);
			await setUp(plugin, [identity(tiers), echo]);
			await plugin.preflight?.();
		}
	});
});
