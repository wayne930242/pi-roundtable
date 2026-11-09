import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PlaceProvider } from "../contract/places.ts";
import type { AgentRuntime } from "../contract/runtime.ts";
import { PluginError } from "../kernel/errors.ts";
import { silentLogger } from "../kernel/log.ts";
import type {
	PromptDocumentSpec,
	PromptDocuments,
} from "../modules/prompts/prompt-documents.ts";
import { ErrorReporter } from "../ops/error-reporter.ts";
import type {
	LinkedSessions,
	PluginContext,
	RoundtablePlugin,
} from "../plugin-api/plugin.ts";
import {
	AGENTS,
	BACKGROUND_TURNS,
	type BackgroundTurns,
	PROMPTS,
	RUNTIME,
	SCHEDULES,
	type ScheduleStore,
} from "../plugin-api/services.ts";
import {
	collectContributions,
	linkSessions,
} from "../registry/contributions.ts";
import { resolveProviders } from "../registry/providers.ts";
import { ServiceRegistry } from "../registry/services.ts";
import { agentSessionsSlot } from "../runtime/runtime-plugin.ts";
import { toolTiers } from "../runtime/tool-tiers.ts";
import {
	discordTestPlaces,
	legacyRows,
	storedFrom,
} from "../testing/team-places.ts";
import {
	type AgentServerOptions,
	type AgentServerStores,
	agentServerPlugin,
	LOCAL_TEAM_ID,
} from "./agent-server.ts";
import { placesPlugin } from "./agent-server-test-kit.ts";
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

/** The stored places of a stand-in store: none, and no reader to link. */
const NO_PLACES = {
	places: { on: () => undefined, ownerOf: () => undefined },
	readPlacesWith: () => undefined,
};

/** Stand-in stores: the members of a store a test reads, and none of the places. */
const standIn = (agents: object) =>
	// SAFETY: the team reads only the members the test gives, and the places.
	({ agents: { ...NO_PLACES, ...agents } }) as unknown as AgentServerStores;

// SAFETY: setup hands the store to the team and registry, which read it only when a turn or a command runs.
const stores = standIn({});

/** The runtime plugin's runtime, as the agent server reads it. */
const runtime = { name: "runtime" } as unknown as AgentRuntime;

/** The agent server set up over stand-in stores and Discord, as far as setup reads them. */
async function setUp(
	plugin: RoundtablePlugin,
	filling: RoundtablePlugin[] = [],
	personas: Record<string, string> = {},
	prompts?: PromptDocuments,
	surfaces: Record<string, unknown> = {},
	/** The place providers the plugins contribute, such as Discord's. */
	providers: PlaceProvider[] = [],
) {
	const rooms =
		typeof surfaces.roomSurfaces === "function"
			? (surfaces.roomSurfaces as () => string[])()
			: [];
	const plugins = [...placesPlugin(rooms, providers), ...filling, plugin];
	const services = new ServiceRegistry([...plugins]);
	if (prompts) services.preset(PROMPTS, prompts);
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
			...surfaces,
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

describe("the agent server's prompts", () => {
	/** A document registry that only records what is registered. */
	function recording() {
		const registered: PromptDocumentSpec[] = [];
		const documents = {
			register: (spec: PromptDocumentSpec) => {
				registered.push(spec);
				return { id: spec.id, text: () => `current ${spec.id}` };
			},
		} as unknown as PromptDocuments;
		return { documents, registered };
	}

	test("the shared and guest prompts are registered as documents with the configured text as the file version", async () => {
		const { documents, registered } = recording();
		await setUp(
			agentServerPlugin(
				options({
					prompts: { shared: "the shared text", guest: "the guest text" },
				}),
				async () => stores,
			),
			[],
			{},
			documents,
		);
		expect(registered.map(({ id, default: text }) => [id, text])).toEqual([
			["shared", "the shared text"],
			["guest", "the guest text"],
		]);
		expect(registered.every((spec) => spec.label.length > 0)).toBe(true);
	});

	test("without a guest prompt only the shared one is registered, and without the prompts service nothing is", async () => {
		const { documents, registered } = recording();
		await setUp(
			agentServerPlugin(options(), async () => stores),
			[],
			{},
			documents,
		);
		expect(registered.map((spec) => spec.id)).toEqual(["shared"]);
		const { services } = await setUp(
			agentServerPlugin(options(), async () => stores),
		);
		expect(services.find(PROMPTS)).toBeUndefined();
	});
});

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
			"agent-groups-channel-optional",
			"agents-character",
			"agents-helpers",
			"agents-helper-origin",
			"agent-prompt-history",
			"agent-outbox",
			"agent-latest-conversation",
			"helper-presets",
			"agents-helper-preset",
			"helper-presets-shared",
			"agent-places",
			"team-move",
			"agent-places-from-channels",
		]);
	});
});

describe("the agent server without Discord", () => {
	/** The options of a host without Discord: no guild, entry channel or public address, and a named coordinator. */
	function local(extra: Partial<AgentServerOptions> = {}) {
		const {
			guildId: _guild,
			entryChannelId: _entry,
			avatarListener: _listener,
			avatarUrl: _url,
			...rest
		} = options();
		return { ...rest, coordinator: "guide", ...extra };
	}

	/** The plugin set up with no Discord service, as a host without Discord has none. */
	async function setUpLocal(
		plugin: RoundtablePlugin,
		rooms: string[],
		filling: RoundtablePlugin[] = [],
		background: Partial<BackgroundTurns> = {},
		sendReply: (channel: string, reply: unknown) => Promise<void> = async () =>
			undefined,
	) {
		const plugins = [...placesPlugin(rooms, []), ...filling, plugin];
		const services = new ServiceRegistry([...plugins]);
		services.preset(SCHEDULES, {} as ScheduleStore);
		services.preset(BACKGROUND_TURNS, background as BackgroundTurns);
		services.preset(RUNTIME, runtime);
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
			events: { changed: () => undefined },
			conversations: {},
			surfaces: {
				roomSurfaces: () => rooms,
				prompts: () => undefined,
				react: async () => undefined,
				startTyping: () => () => undefined,
				showStop: () => () => undefined,
				sendReply,
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
		return { services, registry };
	}

	test("keeps its rows under the local team and sets up with no channel, dashboard or avatar route", async () => {
		const opened: string[] = [];
		const plugin = agentServerPlugin(local(), async (_context, teamId) => {
			opened.push(teamId);
			return stores;
		});
		expect(plugin.migrations?.map((m) => m.name)).toContain(
			"agent-groups-channel-optional",
		);
		const { services, registry } = await setUpLocal(plugin, ["app"]);
		expect(opened).toEqual([LOCAL_TEAM_ID]);
		expect(services.get(AGENTS).team.guildId).toBe(LOCAL_TEAM_ID);
		// The dashboard is a Discord message, and the pictures have no public address to be served at.
		expect(registry.services.map((service) => service.name)).not.toContain(
			"dashboard",
		);
		expect(registry.routes).toEqual([]);
		expect(services.get(AGENTS).avatars.url("a".repeat(64))).toBe(
			`/avatars/${"a".repeat(64)}.png`,
		);
	});

	test("keeps its rows under the team id it is given, not the guild", async () => {
		const opened: string[] = [];
		const plugin = agentServerPlugin(
			options({ teamId: "crew" }),
			async (_context, teamId) => {
				opened.push(teamId);
				return stores;
			},
		);
		const { services } = await setUpLocal(plugin, ["app"]);
		expect(opened).toEqual(["crew"]);
		expect(services.get(AGENTS).team.guildId).toBe("crew");
		expect(services.get(AGENTS).team.discordGuild).toBe("g1");
	});

	test("moves a former team's rows after the team's tables, at every boot", () => {
		const moving = agentServerPlugin(
			local({ teamId: "crew", formerTeamIds: ["old-guild"] }),
		);
		const names = moving.migrations?.map((m) => m.name) ?? [];
		expect(names.at(-2)).toBe("team-move");
		expect(names.at(-1)).toBe("agent-places-from-channels");
		expect(moving.migrations?.find((m) => m.name === "team-move")?.runs).toBe(
			"every-boot",
		);
	});

	test("the error reports go to the primary place of the agent the ops place names, in its web room", async () => {
		const posted: string[] = [];
		const reports: string[] = [];
		const errorReporter = new ErrorReporter({
			destination: { agent: "infra" },
			app: "Roundtable",
			configKey: "routing.places.ops",
		});
		errorReporter.record({ level: 50, msg: "disk full" });
		const infra = { name: "infra", status: "active" };
		// SAFETY: the team reads only these members of the store while it starts without Discord.
		const seeded = standIn({
			agent: (name: string) => (name === "infra" ? infra : undefined),
			agents: () => [],
			group: () => undefined,
			seed: async () => [],
			conversations: { latest: () => undefined },
			outbox: { pending: async () => [] },
			hasStoredCharacter: () => false,
		});
		const plugin = agentServerPlugin(
			local({
				coordinator: "infra",
				errorReporter,
				routing: {
					agents: { infra: { primary: "app" } },
					places: { ops: { agent: "infra" } },
				},
			}),
			async () => seeded,
		);
		const { registry } = await setUpLocal(
			plugin,
			["app"],
			[],
			{
				runErrorReport: async (channel: string) => {
					reports.push(channel);
					return { status: "ran" as const };
				},
			},
			async (channel) => void posted.push(channel),
		);
		const team = registry.services.find((service) => service.name === "team");
		await team?.startInBackground?.();
		await Bun.sleep(20);
		expect(posted).toEqual(["app:agent.infra"]);
		expect(reports).toEqual(["app:agent.infra"]);
	});

	test("refuses to start when no surface hosts the agents' rooms, and starts when one does", async () => {
		const bare = agentServerPlugin(local(), async () => stores);
		await setUpLocal(bare, []);
		expect(() => bare.preflight?.()).toThrow(
			"agents need a surface that hosts their rooms, such as pi-roundtable-web",
		);
		const hosted = agentServerPlugin(local(), async () => stores);
		await setUpLocal(hosted, ["app"]);
		expect(() => hosted.preflight?.()).not.toThrow();
	});

	test("names the first seed the coordinator when the options name none, and the named one otherwise", async () => {
		const active = (name: string) => ({
			name,
			displayName: name,
			prompt: "",
			avatarPrompt: "",
			status: "active",
		});
		const roster = standIn({ agent: (name: string) => active(name) });
		const seeded = (names: string[]): RoundtablePlugin => ({
			name: "seeded",
			setup: () => ({
				seeds: names.map((name) => ({ ...active(name), channelId: undefined })),
			}),
		});
		const { coordinator: _named, ...unnamed } = local();
		const coordinatorOf = async (
			given: AgentServerOptions,
			names: string[],
		) => {
			const { services } = await setUpLocal(
				agentServerPlugin(given, async () => roster),
				["app"],
				// A plugin that seeds nothing adds nothing, which the registry refuses.
				names.length > 0 ? [seeded(names)] : [],
			);
			return services.get(AGENTS).team.coordinator();
		};
		expect(await coordinatorOf(unnamed, ["guide", "scout"])).toBe("guide");
		expect(
			await coordinatorOf(local({ coordinator: "scout" }), ["guide", "scout"]),
		).toBe("scout");
		expect(await coordinatorOf(unnamed, [])).toBeUndefined();
	});

	test("refuses an entry channel and a coordinator together", () => {
		expect(() =>
			agentServerPlugin({ ...options(), coordinator: "guide" }),
		).toThrow(/both name the coordinator/);
	});
});

describe("the agents' workspace", () => {
	test("is the configured working directory, and the scratch dir when one is set", async () => {
		const plainOptions = options();
		const plain = await setUp(
			agentServerPlugin(plainOptions, async () => stores),
		);
		expect(plain.services.get(AGENTS).workspace).toEqual({
			workDir: plainOptions.workDir,
		});
		const scratchOptions = options();
		const scratchDir = join(scratchOptions.workDir, "..", "scratch");
		const scratch = await setUp(
			agentServerPlugin({ ...scratchOptions, scratchDir }, async () => stores),
		);
		expect(scratch.services.get(AGENTS).workspace).toEqual({
			workDir: scratchOptions.workDir,
			scratchDir,
		});
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

describe("the agent server's routing", () => {
	const known = new Map(
		["infra", "coder"].map((name) => [
			name,
			{ name, status: "active", channelId: name === "infra" ? "2000" : "4000" },
		]),
	);
	// SAFETY: the table reads only `agent` and `conversations.latest` of the store.
	const routed = {
		agents: {
			...NO_PLACES,
			places: storedFrom(() => legacyRows([...known.values()])),
			agent: (name: string) => known.get(name),
			agentByChannel: (id: string) =>
				[...known.values()].find((a) => a.channelId === id),
			group: () => undefined,
			groupByChannel: () => undefined,
			conversations: { latest: () => undefined },
		},
	} as unknown as AgentServerStores;
	const surfaces = {
		roomSurfaces: () => ["app"],
		names: () => ["discord", "app"],
	};
	const infraOnWeb = {
		agents: { infra: { primary: "app", integration: "primary" } },
		places: { ops: { agent: "infra" } },
	};

	test("the server hands the plugins the routing table the configuration set", async () => {
		const { services } = await setUp(
			agentServerPlugin(options({ routing: infraOnWeb }), async () => routed),
			[],
			{},
			undefined,
			surfaces,
			[discordTestPlaces()],
		);
		const { routes } = services.get(AGENTS);
		expect(routes?.primary("infra")).toBe("app:agent.infra");
		expect(routes?.primary("coder")).toBe("discord:4000");
		expect(routes?.of("infra", "integration", "discord:2000")).toBe(
			"app:agent.infra",
		);
		expect(routes?.place("ops")).toBe("app:agent.infra");
	});

	test("without routing the table is the defaults: Discord first, every report where it was posted", async () => {
		const { services } = await setUp(
			agentServerPlugin(options(), async () => routed),
			[],
			{},
			undefined,
			surfaces,
			[discordTestPlaces()],
		);
		const { routes } = services.get(AGENTS);
		expect(routes?.primary("infra")).toBe("discord:2000");
		expect(routes?.of("infra", "integration", "discord:2000")).toBe(
			"discord:2000",
		);
		expect(routes?.place("ops")).toBeUndefined();
	});

	test("the claim runs a webhook's report turn where the routing table puts it", async () => {
		const reportChannel = async (routing?: AgentServerOptions["routing"]) => {
			const { registry } = await setUp(
				agentServerPlugin(
					options(routing ? { routing } : {}),
					async () => routed,
				),
				[],
				{},
				undefined,
				surfaces,
				[discordTestPlaces()],
			);
			const claim = registry.channels.find((c) => c.name === "agent-server");
			const admission = claim?.admit({
				channel: "discord:2000",
				messageId: "m1",
				authorId: "hook-user",
				authorName: "Alertmanager",
				authorIsBot: true,
				isDirect: false,
				space: "g1",
				mentionsBot: false,
				repliesToBot: false,
				text: "disk 91%",
				attachments: [],
				integration: { id: "hook", own: false },
			});
			return admission?.kind === "background"
				? admission.turn.channel
				: undefined;
		};
		expect(await reportChannel()).toBe("discord:2000");
		expect(await reportChannel(infraOnWeb)).toBe("app:agent.infra");
	});

	test("a webhook's post in an agent's app room is the claim's, and starts a background report turn there", async () => {
		const { registry } = await setUp(
			agentServerPlugin(options(), async () => routed),
			[],
			{},
			undefined,
			surfaces,
			[discordTestPlaces()],
		);
		const claim = registry.channels.find((c) => c.name === "agent-server");
		expect(claim?.owns("app:agent.infra")).toBe(true);
		const admission = claim?.admit({
			channel: "app:agent.infra",
			messageId: "app:41",
			authorId: "webhook:h1",
			authorName: "CI",
			authorIsBot: true,
			isDirect: false,
			mentionsBot: false,
			repliesToBot: false,
			text: "build 12 failed",
			attachments: [],
			integration: { id: "h1", own: false },
		});
		expect(admission?.kind).toBe("background");
		if (admission?.kind !== "background") return;
		expect(admission.turn.channel).toBe("app:agent.infra");
		expect(admission.turn.text).toStartWith('Webhook "CI" posted in');
		expect(admission.turn.text).toEndWith("build 12 failed");
	});

	test("the preflight passes for registered surfaces and refuses one nobody registered, naming the key", async () => {
		const good = agentServerPlugin(
			options({ routing: infraOnWeb }),
			async () => routed,
		);
		await setUp(good, [], {}, undefined, surfaces, [discordTestPlaces()]);
		await good.preflight?.();
		const bad = agentServerPlugin(
			options({
				routing: { agents: { infra: { primary: "slack" } }, places: {} },
			}),
			async () => routed,
		);
		await setUp(bad, [], {}, undefined, surfaces, [discordTestPlaces()]);
		expect(async () => bad.preflight?.()).toThrow(
			'config routing.agents.infra.primary: no surface is registered as "slack"',
		);
	});
});
