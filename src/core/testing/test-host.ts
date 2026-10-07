import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionFactory,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { DISCORD, type DiscordServices } from "../builtin/discord.ts";
import { type RoundtableConfig, resolveConfig } from "../config/config.ts";
import type { ConversationPort } from "../contract/channels.ts";
import type { AgentRuntime } from "../contract/runtime.ts";
import type { ChatSurface } from "../contract/surface.ts";
import { defineRoundtable } from "../define-roundtable.ts";
import { CommandCollection } from "../discord/command-collection.ts";
import type { ComposedCommands } from "../discord/compose-commands.ts";
import type { DiscordConnection } from "../discord/connection.ts";
import type {
	CommandGuard,
	InteractionContribution,
} from "../discord/interaction-module.ts";
import { OwnerGuard, ownerRootCommand } from "../discord/owner-command.ts";
import { Roundtable } from "../host.ts";
import { silentLogger } from "../log.ts";
import type { PluginContext, RoundtablePlugin } from "../plugin.ts";
import { CompactionTiers } from "../runtime/compaction-tiers.ts";
import { sessionExtensions } from "../runtime/runtime-types.ts";
import type { AgentTurnScope, SessionContext } from "../sessions.ts";
import { testDatabaseUrl } from "./database.ts";

export interface TestHostOptions {
	/**
	 * Over a test configuration: an owner, a guild, a temporary `dataDir`, and the test database
	 * (`ROUNDTABLE_TEST_DATABASE_URL`).
	 */
	config?: Partial<RoundtableConfig>;
	/** The app's plugins, after the built-in ones, as `defineRoundtable` places them. */
	plugins?: readonly RoundtablePlugin[];
	/** The runtime every turn runs on; by default one that answers "" and builds no Pi session. */
	runtime?: AgentRuntime;
	/**
	 * The credentials `context.apiKey` returns, by provider name; a provider not listed reads as
	 * having none, whatever login the machine holds.
	 */
	apiKeys?: Readonly<Record<string, string>>;
	/**
	 * What the stand-in Discord hands out. `false` boots a host without Discord: no `discord`,
	 * `http`, or `agents` in the configuration, so no Discord plugin and no agent server.
	 */
	discord?:
		| false
		| Partial<Pick<DiscordConnection, "agentChannels" | "ownerChannel">>;
}

export interface TestHost {
	/** A probe plugin's context, set up after every other plugin. */
	context: PluginContext;
	/** The host's conversations, as a surface would drive them. */
	conversations: ConversationPort;
	commands: {
		/** Every slash-command contribution the plugins handed Discord, in the order added. */
		added: readonly InteractionContribution[];
		/** The tree Discord would register under the root command; closes the collection to later additions. */
		composed(): ComposedCommands;
	};
	/** The tools each extension of a session registers, in plan order; the owner's session unless a scope is given. */
	sessionTools(
		scope?: AgentTurnScope,
	): Promise<{ extension: string; tools: string[] }[]>;
	/** A session context as the runtime builds it, with the real compaction wrapper. */
	sessionContext(scope?: AgentTurnScope): SessionContext;
	/** Stops the host, services first-started last. */
	stop(): Promise<void>;
}

function defaultConfig(withDiscord: boolean): RoundtableConfig {
	const dataDir = mkdtempSync(join(tmpdir(), "roundtable-test-host-"));
	if (!withDiscord)
		return {
			owner: { id: "100000000000000001", name: "Ada" },
			database: { url: testDatabaseUrl },
			dataDir,
			model: "anthropic/claude-sonnet-5-5",
		};
	return {
		owner: { id: "100000000000000001", name: "Ada" },
		discord: {
			token: "token",
			guild: "900000000000000001",
			entryChannel: "900000000000000002",
		},
		database: { url: testDatabaseUrl },
		dataDir,
		model: "anthropic/claude-sonnet-5-5",
		http: {
			publicUrl: "https://bot.example.com",
			socketPath: join(dataDir, "public.sock"),
		},
		agents: [
			{
				name: "librarian",
				displayName: "Librarian",
				prompt: "You keep the reading list.",
				avatarPrompt: "A calm librarian",
			},
		],
	};
}

/** A runtime that answers nothing, so the agent server builds no Pi session. */
function quietRuntime(): AgentRuntime {
	return {
		runTurn: async () => ({ ok: true, text: "" }),
		steer: async () => false,
		stop: () => false,
		startFresh: async () => undefined,
		deleteConversation: async () => undefined,
		pendingConfirmation: () => undefined,
		heldActions: async () => undefined,
		recentTranscript: async () => [],
	};
}

/** A Discord that connects to nothing, recording the commands added to it, standing in for the built-in plugin that does. */
function standInDiscord(
	commands: CommandCollection,
	guard: CommandGuard,
	given: TestHostOptions["discord"],
): RoundtablePlugin {
	const surface: ChatSurface = {
		surface: "discord",
		start: async () => undefined,
		sendReply: async () => undefined,
	};
	return {
		name: "test-discord",
		provides: [DISCORD],
		replaces: [DISCORD],
		setup: ({ services }) => {
			// SAFETY: the plugins after it read only these members while they set up; the rest is read when a tool runs, which a test host does not do.
			services.provide(DISCORD, {
				connection: {
					agentChannels: () => ({}),
					agentDashboard: () => ({ show: async () => undefined }),
					onChannelDeleted: () => undefined,
					ownerChannel: async () => "discord:owner-dm",
					ownerOperations: () => ({}),
					...given,
				},
				commands: commands.registrar,
				guard,
				threads: { open: async () => undefined, sweep: async () => undefined },
			} as unknown as DiscordServices);
			return { surfaces: [surface] };
		},
	};
}

/** Anything an extension may call or read on the Pi API besides registering a tool: accepted, does nothing. */
type Ignored = (...args: readonly never[]) => Ignored;

function ignored(): Ignored {
	return new Proxy((() => ignored()) as Ignored, {
		get: (target, key) => (key === "then" ? undefined : target),
	});
}

/** The tools a factory registers, by name; every other registration (handlers, commands, events) is accepted and ignored. */
async function registeredBy(factory: ExtensionFactory): Promise<string[]> {
	const names: string[] = [];
	// SAFETY: a session factory only registers tools, handlers and commands; the fake records the tool names and ignores the rest.
	const registerTool = (tool: { name: string }) => names.push(tool.name);
	const api = new Proxy(
		{},
		{
			get: (_target, key) =>
				key === "registerTool" ? registerTool : ignored(),
		},
	) as unknown as ExtensionAPI;
	await factory(api);
	return names;
}

const noop: ExtensionFactory = () => undefined;
/** The core's own extensions, which a session here does not load: only the plugins' registrations are listed. */
const CORE_EXTENSIONS = {
	readAttachment: noop,
	confirmationGate: noop,
	askUser: noop,
	selfCompactGuard: noop,
	activeTools: noop,
};

/**
 * Boots `defineRoundtable` over the test database with Discord and the runtime standing in, so
 * a test sees the built-in plugins and the app's plugins as a host runs them. It needs
 * PostgreSQL: run it under `describeDb`. Stop it when the test ends.
 */
export async function testHost(
	options: TestHostOptions = {},
): Promise<TestHost> {
	const commands = new CommandCollection();
	const runtime = options.runtime ?? quietRuntime();
	let captured: PluginContext | undefined;
	const probe: RoundtablePlugin = {
		name: "probe",
		setup: (context) => {
			captured = context;
			return { services: [{ name: "probe" }] };
		},
	};
	const withDiscord = options.discord !== false;
	const given = options.discord === false ? undefined : options.discord;
	const base: RoundtableConfig = {
		...defaultConfig(withDiscord),
		...options.config,
	};
	const resolved = resolveConfig(base);
	const rootCommand = resolved.slug;
	const guard = new OwnerGuard(resolved.owner.id, silentLogger(), rootCommand);
	const config: RoundtableConfig = {
		...base,
		plugins: [
			...(withDiscord ? [standInDiscord(commands, guard, given)] : []),
			{
				name: "test-runtime",
				providers: { runtime: () => runtime },
				setup: () => ({}),
			},
			...(options.plugins ?? []),
			probe,
		],
	};
	const defined = await defineRoundtable(config, { logger: silentLogger() });
	const apiKeys = options.apiKeys ?? {};
	const roundtable = new Roundtable(
		{
			...defined.options,
			apiKey: async (provider) =>
				Object.hasOwn(apiKeys, provider) ? apiKeys[provider] : undefined,
		},
		defined.plugins,
	);
	await roundtable.run();
	if (!captured) throw new Error("the probe was not set up");
	const context = captured;
	// Without Discord the owner's session is a conversation of a plugin's surface.
	const ownerChannel = withDiscord
		? await (given?.ownerChannel ?? (async () => "discord:owner-dm" as const))()
		: ("test:owner" as const);
	/** A group seat's turns run in the group's channel; an agent's in its own. */
	const turnChannelOf = (scope?: AgentTurnScope) =>
		scope?.group ? scope.session : scope?.home;
	const sessionContext = (scope?: AgentTurnScope): SessionContext => {
		const tiers = new CompactionTiers(
			SessionManager.inMemory(tmpdir()),
			() => undefined,
			context.sessions().plan.compaction?.engine,
		);
		const built: SessionContext = {
			kind: scope ? "agent" : "owner",
			homeChannel: scope?.home ?? ownerChannel,
			turnChannel: turnChannelOf(scope) ?? ownerChannel,
			compaction: {
				wrap: (compactor) => tiers.wrapCompactor(compactor, () => undefined),
			},
			speaker: () => undefined,
			runTask: async () => {
				throw new Error("a test host session cannot run tasks");
			},
		};
		if (scope) built.agent = scope;
		return built;
	};
	return {
		context,
		conversations: context.conversations,
		commands: {
			added: commands.added(),
			composed: () => commands.compose(ownerRootCommand(rootCommand)),
		},
		sessionTools: async (scope) => {
			const tools: { extension: string; tools: string[] }[] = [];
			for (const extension of sessionExtensions(
				context.sessions().plan,
				sessionContext(scope),
				CORE_EXTENSIONS,
			))
				tools.push({
					extension: extension.name,
					tools: await registeredBy(extension.factory),
				});
			return tools;
		},
		sessionContext,
		stop: async () => {
			await roundtable.shutdown("test");
		},
	};
}

/** The default delegation worker reads pi-web-access, which a checkout has and the exported package does not list. */
export function hasWebAccess(): boolean {
	try {
		import.meta.resolve("pi-web-access/package.json");
		return true;
	} catch {
		return false;
	}
}
