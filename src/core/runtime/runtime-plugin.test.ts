import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
	AgentRuntime,
	AgentSessions,
	HeldActionStore,
	RuntimeDeps,
} from "../contract/runtime.ts";
import { PluginError } from "../errors.ts";
import { silentLogger } from "../log.ts";
import type { PluginContext, RoundtablePlugin } from "../plugin.ts";
import {
	collectContributions,
	linkSessions,
} from "../registry/contributions.ts";
import { resolveProviders } from "../registry/providers.ts";
import { ServiceRegistry } from "../registry/services.ts";
import { RUNTIME } from "../services.ts";
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
	const context = {
		logger: silentLogger(),
		env: { locale: "en", timeZone: "UTC", now: () => new Date() },
		sessions: () => {
			throw new Error("not linked");
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
	linkSessions(registry);
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
