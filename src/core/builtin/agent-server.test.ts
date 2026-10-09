import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentRuntime } from "../contract/runtime.ts";
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
import { agentSessionsSlot } from "../runtime/runtime-plugin.ts";
import {
	AGENTS,
	BACKGROUND_TURNS,
	type BackgroundTurns,
	RUNTIME,
	SCHEDULES,
	type ScheduleStore,
} from "../services.ts";
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
		// SAFETY: building the runtime reads nothing of the model runtime; a turn would.
		modelRuntime: {} as ModelRuntime,
		dataDir: join(dir, "data"),
		model: { provider: "test", id: "model" },
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

// SAFETY: setup hands the store to the team and registry, which read it only when a turn or a command runs.
const stores = { agents: {} } as unknown as AgentServerStores;

/** The runtime plugin's runtime, as the agent server reads it. */
const runtime = { name: "runtime" } as unknown as AgentRuntime;

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
	services.preset(RUNTIME, runtime);
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
	return { services, registry, context, linked };
}

describe("the agent server's runtime", () => {
	test("is the runtime plugin's, and the server hands it the agents' settings", async () => {
		const slot = agentSessionsSlot();
		const { services } = await setUp(
			agentServerPlugin(options({ agents: slot }), async () => stores),
		);
		expect(services.get(AGENTS).runtime).toBe(runtime);
		expect(slot.current()?.workDir).toContain("work");
	});

	test("memory is left out of the settings unless the option names it", async () => {
		for (const memory of [undefined, "owners"] as const) {
			const slot = agentSessionsSlot();
			await setUp(
				agentServerPlugin(
					options({ agents: slot, ...(memory ? { memory } : {}) }),
					async () => stores,
				),
			);
			expect(slot.current()?.memory).toBe(memory);
		}
	});

	test("the server needs the runtime plugin, and leaves the held actions' table to it", () => {
		const plugin = agentServerPlugin(options(), async () => stores);
		expect(plugin.requires?.map((key) => key.id)).toEqual([
			"roundtable.runtime",
		]);
		expect(plugin.migrations?.map((m) => m.name)).toEqual([
			"agents",
			"agents-guild",
		]);
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
