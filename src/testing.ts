import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SQL } from "bun";
import { agentClaim } from "./core/agents/agent-claim.ts";
import { DISCORD } from "./core/builtin/discord.ts";
import type {
	ConversationPort,
	InboundMessage,
} from "./core/contract/channels.ts";
import type { Providers } from "./core/contract/providers.ts";
import type {
	AgentRuntime,
	HeldActionStore,
	RuntimeDeps,
} from "./core/contract/runtime.ts";
import type { ServiceKey } from "./core/contract/services.ts";
import type { ChatSurface, SurfacePort } from "./core/contract/surface.ts";
import { CommandCollection } from "./core/discord/command-collection.ts";
import type { ComposedCommands } from "./core/discord/compose-commands.ts";
import type {
	CommandGuard,
	CommandRegistrar,
	InteractionContribution,
} from "./core/discord/interaction-module.ts";
import {
	commandGuard,
	ownerRootCommand,
} from "./core/discord/owner-command.ts";
import type {
	PendingConfirmation,
	ReplyFile,
} from "./core/domain/conversation.ts";
import { NotLinkedError, PluginError } from "./core/errors.ts";
import { EventBus } from "./core/events.ts";
import type { HoldCheck } from "./core/holds.ts";
import { contactsOf } from "./core/identity/identity-view.ts";
import type { OwnerIdentity } from "./core/identity.ts";
import { ConfirmationJudge } from "./core/judging/confirmation-judge.ts";
import { silentLogger } from "./core/log.ts";
import { ConversationBackgroundTurns } from "./core/modules/background/background-turns.ts";
import { PERSONAL_TARGET } from "./core/modules/background/personal-target.ts";
import type {
	Contribution,
	HostEnv,
	LinkedSessions,
	PluginContext,
	RoundtablePlugin,
	TurnEndEvent,
	TurnEvent,
	TurnProgressEvent,
} from "./core/plugin.ts";
import {
	collectContributions,
	linkSessions,
} from "./core/registry/contributions.ts";
import { resolveProviders } from "./core/registry/providers.ts";
import { ServiceRegistry } from "./core/registry/services.ts";
import {
	attachReplyFile,
	hasReplyFileScope,
	withReplyFiles,
} from "./core/reply-files.ts";
import { ChannelQueue } from "./core/routing/channel-queue.ts";
import { ChannelRouter } from "./core/routing/channel-router.ts";
import {
	type ConversationTurns,
	conversationTurns,
} from "./core/routing/conversation-turns.ts";
import { surfacePort } from "./core/routing/surface-port.ts";
import {
	AGENTS,
	type AgentServer,
	BACKGROUND_TURNS,
	CONVERSATIONS,
	IDENTITY,
	RUNTIME,
} from "./core/services.ts";
import type { ChannelKey, SessionContext } from "./core/sessions.ts";
import { type Speaker, THE_SPEAKER } from "./core/speakers.ts";
import { mapIdentity } from "./core/testing/map-identity.ts";
import { type ToolTierTable, toolTiers } from "./core/tool-tiers.ts";

// Fixtures for plugin tests.

export { silentLogger } from "./core/log.ts";
export type { TestStore } from "./core/testing/database.ts";
export {
	describeDb,
	openTestStore,
	TEST_GUILD,
	testDatabaseUrl,
} from "./core/testing/database.ts";
export { eagerText, useEagerCatalog } from "./core/testing/eager-catalog.ts";
export type { TestLocale } from "./core/testing/locale.ts";
export { useTestLocale } from "./core/testing/locale.ts";
export { OWNER_SPEAKER } from "./core/testing/owner.ts";
export { partial } from "./core/testing/partial.ts";
export type {
	FakePrecheck,
	FakePrecheckAnswer,
	FakeScriptAnswer,
	FakeScriptRunner,
} from "./core/testing/prechecks.ts";
export {
	fakePrecheck,
	fakePrechecks,
	fakeScriptRunner,
} from "./core/testing/prechecks.ts";
export type {
	RecordedLog,
	RecordingLogger,
} from "./core/testing/recording-logger.ts";
export { recordingLogger } from "./core/testing/recording-logger.ts";
export type {
	SurfaceContractAnswerer,
	SurfaceContractFailure,
	SurfaceContractSubject,
	SurfaceObservation,
} from "./core/testing/surface-contract.ts";
export {
	checkSurfaceContract,
	describeSurfaceContract,
} from "./core/testing/surface-contract.ts";
export type { TestHost, TestHostOptions } from "./core/testing/test-host.ts";
export { testHost } from "./core/testing/test-host.ts";
export type { FakeThreadHost } from "./core/testing/thread-host.ts";
export { fakeThreads } from "./core/testing/thread-host.ts";

/**
 * A service the plugin under test reads, with the members the test gives it, made by
 * `servicePair(KEY, { ... })`. Reading a member the test did not give throws a PluginError that
 * names it.
 */
export interface ServicePair {
	readonly key: ServiceKey<unknown>;
	readonly given: object;
}

/** Pairs a service key with the members the test gives it, for the `services` option of `testPlugin`. */
export function servicePair<T extends object>(
	key: ServiceKey<T>,
	given: Partial<T>,
): ServicePair {
	return { key, given };
}

/** A stand-in for the Discord plugin's `DISCORD` service, made by `fakeDiscord()`. */
export interface FakeDiscord {
	/** Give this to `testPlugin`'s `services` option: `{ services: [discord.service] }`. */
	readonly service: ServicePair;
	/** What `DISCORD.commands` is to the plugin: the real registrar, which refuses what the Discord plugin refuses. */
	readonly commands: CommandRegistrar;
	/** What `DISCORD.guard` is: the owner, `owner` unless the test gave another id, serving the root command. */
	readonly guard: CommandGuard;
	/** Every contribution the plugin added, in the order it added them. */
	added(): readonly InteractionContribution[];
	/** The tree the Discord plugin would register, composed under the root command the fake was made with. */
	compose(): ComposedCommands;
}

/**
 * A `DISCORD` service for a plugin that adds slash commands, without a Discord connection: the
 * plugin's `commands.add` calls are recorded, and `compose()` shows the tree Discord would get.
 * `rootCommand` is the root command's name, `roundtable` by default. Only `commands` and `guard` are given; reading another member throws.
 */
export function fakeDiscord(
	options: { ownerId?: string; rootCommand?: string } = {},
): FakeDiscord {
	const collection = new CommandCollection();
	const { rootCommand = "roundtable" } = options;
	const guard = commandGuard({
		ownerId: options.ownerId ?? "owner",
		root: rootCommand,
		logger: silentLogger(),
	});
	return {
		service: servicePair(DISCORD, { commands: collection.registrar, guard }),
		commands: collection.registrar,
		guard,
		added: () => collection.added(),
		compose: () => collection.compose(ownerRootCommand(rootCommand)),
	};
}

export interface TestPluginOptions {
	/** The host environment the plugin sees; default en and UTC. */
	env?: Partial<HostEnv>;
	/**
	 * The owner the runtime's dependencies and the agent server's claim know; default `owner`,
	 * named Owner, who is addressed as they.
	 */
	owner?: { id: string; name: string; pronouns?: OwnerIdentity["pronouns"] };
	database?: SQL;
	providers?: Partial<Providers>;
	/**
	 * Chat surfaces besides the plugin's own, such as a fake one: they are in `context.surfaces`,
	 * started with the plugin's services (their messages reach `conversations`), and stopped last.
	 */
	surfaces?: readonly ChatSurface[];
	/**
	 * What the plugin reads from `context.services`, one `servicePair(KEY, { ... })` per service.
	 * `servicePair(RUNTIME, runtime)` is the runtime that `context.turns` runs turns on, given
	 * whole rather than member by member; `servicePair(AGENTS, { runtime })` still works when no
	 * `RUNTIME` is given. Without either, a plugin that fills the `runtime` slot gets the runtime its
	 * provider builds, under both keys. A service
	 * not given here reads as absent to `find`, and `get` names this option, except for what the
	 * host supplies anyway: `BACKGROUND_TURNS`, the real background turns over the test's router,
	 * and, once `AGENTS` is given, its `approvals` (the real confirmation judge over
	 * `providers.judge`, when the test gives a judge). Giving `AGENTS` a `team` adds the agent
	 * server's own claim to the router, answering as the host's would for the `owner`. The router
	 * resolves who wrote each message through a given `IDENTITY`; without one only the `owner` is
	 * anyone, at the owner tier, their principal their id.
	 */
	services?: readonly ServicePair[];
	/**
	 * The plugin's conversations: by default a router over the plugin's own `channels` claims, so a
	 * message a surface delivers reaches them. Methods given here replace the router's.
	 */
	conversations?: Partial<ConversationPort>;
	/** Replaces `context.turns`, which by default runs turns over the runtime and the surfaces. */
	turns?: ConversationTurns;
	/**
	 * The credentials `context.apiKey` returns, by provider name; a provider not listed reads as
	 * having none, as on a host that is not logged in to it.
	 */
	apiKeys?: Readonly<Record<string, string>>;
	/** How long the router holds a bare forward for the message that follows it; the host option `conversations.forwardJoinMs`. */
	forwardJoinMs?: number;
}

export interface RecordedEvent {
	name: "turnStarted" | "turnEnded" | "changed";
	turn?: TurnEvent | TurnEndEvent;
}

export interface TestPluginResult {
	contribution: Contribution;
	/** The hold rules the plugin contributed, chained as the host links them: the description of a call that must be approved first, or undefined. */
	holds: HoldCheck;
	/** What the plugin sees as `context.conversations`, for a test to drive its claims. */
	conversations: ConversationPort;
	/** What the plugin sees as `context.turns`. */
	turns: ConversationTurns;
	/** What the plugin sees as `context.surfaces`: its own surfaces and the injected ones. */
	surfaces: SurfacePort;
	/** The runtime the plugin's `runtime` provider built, given stand-in dependencies; undefined when it fills no such slot. */
	runtime: AgentRuntime | undefined;
	tools: readonly string[];
	tiers: ToolTierTable;
	events: RecordedEvent[];
	/** Files accepted by successful runTool calls, copied and recorded with their channel. */
	files: { channel: ChannelKey; file: ReplyFile }[];
	runTool(
		name: string,
		args: Record<string, unknown>,
		options?: { speaker?: Speaker; channel?: ChannelKey },
	): Promise<string>;
	stop(): Promise<void>;
}

/** The same pre-link failures and wording the host exposes during setup. */
const NOT_LINKED = {
	conversations:
		"conversations are linked once every plugin is set up. Use them from a service's start or from a handler, not during setup.",
	sessions:
		"session parts are linked once every plugin is set up. Call sessions() from a service's start or from a handler, not during setup.",
	surfaces:
		"chat surfaces are linked once every plugin is set up. Use surfaces from a service's start or from a handler, not during setup.",
	turns:
		"conversation turns are linked once every plugin is set up. Use turns from a service's start or from a handler, not during setup.",
	dashboard:
		"dashboard lines are linked once every plugin is set up. Call dashboard() from a service's start or from a handler, not during setup.",
};

function unlinked(part: keyof typeof NOT_LINKED): never {
	throw new NotLinkedError(NOT_LINKED[part]);
}

/** Members a probe may ask of any object: a test's partial service is not refused for them. */
const PROBED = new Set(["then", "toJSON", "asymmetricMatch"]);

/** A service the test gave only some members of: reading another names the option that adds it. */
function partialService<T extends object>(
	key: ServiceKey<unknown>,
	given: T,
): T {
	return new Proxy(given, {
		get(target, member, receiver) {
			if (member in target || typeof member === "symbol" || PROBED.has(member))
				return Reflect.get(target, member, receiver);
			throw new PluginError(
				`testPlugin gave service ${key.id} no "${member}". Give it in the services option: testPlugin(plugin, { services: [servicePair(KEY, { ${member}: ... })] }).`,
			);
		},
	});
}

/** Held actions kept in memory, for the runtime a plugin's provider builds under test. */
function memoryHeldActions(): HeldActionStore {
	const held = new Map<ChannelKey, PendingConfirmation>();
	return {
		load: async (conversation) => held.get(conversation),
		save: async (conversation, actions) => {
			if (actions) held.set(conversation, actions);
			else held.delete(conversation);
		},
	};
}

/** Build one plugin without Discord or PostgreSQL, retaining the host's validation and tier logic. */
// pi-lens-ignore: high-complexity, large-function — one host's context and lifecycle, mirrored end to end
export async function testPlugin(
	plugin: RoundtablePlugin,
	options: TestPluginOptions = {},
): Promise<TestPluginResult> {
	const logger = silentLogger();
	const owner = {
		id: "owner",
		name: "Owner",
		pronouns: { subject: "they", object: "them", possessive: "their" },
		...options.owner,
	};
	const tiers = toolTiers();
	const bus = new EventBus(logger);
	const events: RecordedEvent[] = [];
	// The plugin under test is the only one registered, so a service it reads comes from the test.
	const services = new ServiceRegistry(
		[plugin],
		"testPlugin has no built-in plugins: give it in the services option, testPlugin(plugin, { services: [servicePair(KEY, { ... })] }).",
	);
	const given = new Map(
		(options.services ?? []).map((pair) => [pair.key.id, pair] as const),
	);
	const agents = given.get(AGENTS.id);
	const resolved = resolveProviders([plugin]);
	let linked: LinkedSessions | undefined;
	let router: ChannelRouter | undefined;
	const queue = new ChannelQueue();
	const conversations: ConversationPort = {
		handle: async (message) =>
			(router ?? unlinked("conversations")).handle(message),
		background: async (turn) =>
			(router ?? unlinked("conversations")).background(turn),
		runsAs: async (turn) => (router ?? unlinked("conversations")).runsAs(turn),
		target: (name) => (router ?? unlinked("conversations")).target(name),
		startFresh: async (channel) =>
			(router ?? unlinked("conversations")).startFresh(channel),
		deleteConversation: async (channel) =>
			(router ?? unlinked("conversations")).deleteConversation(channel),
		stop: (channel) => (router ?? unlinked("conversations")).stop(channel),
		postsInPlace: (channel) =>
			(router ?? unlinked("conversations")).postsInPlace(channel),
		owns: (channel) => (router ?? unlinked("conversations")).owns(channel),
		takesBackground: (channel) =>
			(router ?? unlinked("conversations")).takesBackground(channel),
		...options.conversations,
	};
	const surfaces = surfacePort(() =>
		linked
			? [...registry.surfaces, ...(options.surfaces ?? [])]
			: unlinked("surfaces"),
	);
	const sink = {
		turnStarted: (turn: TurnEvent) => {
			events.push({ name: "turnStarted", turn });
			bus.sink.turnStarted(turn);
		},
		turnEnded: (turn: TurnEndEvent) => {
			events.push({ name: "turnEnded", turn });
			bus.sink.turnEnded(turn);
		},
		// Delivered to the plugin's handlers, not recorded: a turn reports many.
		turnProgress: (event: TurnProgressEvent) => bus.sink.turnProgress?.(event),
		changed: () => {
			events.push({ name: "changed" });
			bus.sink.changed();
		},
	};
	const turns: ConversationTurns =
		options.turns ??
		conversationTurns({
			linked: () => {
				if (!linked) unlinked("turns");
			},
			runtime: () => {
				const given = services.find(RUNTIME);
				if (given) return given;
				const server = services.find(AGENTS);
				return server ? server.runtime : services.get(RUNTIME);
			},
			// A test that gives `CONVERSATIONS` sees each turn record its conversation.
			registry: () => services.find(CONVERSATIONS),
			surfaces,
			events: sink,
			selection: () => (linked ?? unlinked("sessions")).agentSelection(),
			logger,
		});
	const providers = {
		...resolved,
		...options.providers,
		filled: new Set([
			...resolved.filled,
			...(Object.keys(options.providers ?? {}) as (keyof Providers)[]),
		]),
	};
	const env: HostEnv = {
		locale: "en",
		timeZone: "UTC",
		now: () => new Date(),
		...options.env,
	};
	// What the agent server does with the slot: the provider's runtime serves `context.turns`.
	let runtime: AgentRuntime | undefined;
	if (providers.filled.has("runtime")) {
		const deps: RuntimeDeps = {
			logger,
			env,
			owner: { id: owner.id, name: owner.name },
			sessions: () => linked ?? unlinked("sessions"),
			toolTiers: tiers,
			prompts: (channel, speaker) => surfaces.prompts(channel, speaker),
			agents: {
				workDir: tmpdir(),
				skills: () => [],
				modelOf: () => ({ model: "test/model", thinking: "off" }),
				turnChannel: (scope) => scope.home,
			},
			confirmations: memoryHeldActions(),
			judge: providers.judge,
		};
		runtime = providers.runtime(deps);
		// The provider's runtime serves `context.turns` unless the test gave another.
		if (!given.has(RUNTIME.id))
			given.set(RUNTIME.id, { key: RUNTIME, given: runtime });
		if (!agents || !("runtime" in agents.given))
			given.set(AGENTS.id, {
				key: AGENTS,
				given: { ...agents?.given, runtime } satisfies Partial<AgentServer>,
			});
	}
	// Once the agent server is there, it judges the owner's replies to held actions as the host's does.
	const server = given.get(AGENTS.id);
	if (server && providers.filled.has("judge") && !("approvals" in server.given))
		given.set(AGENTS.id, {
			key: AGENTS,
			given: {
				...server.given,
				approvals: new ConfirmationJudge({
					judge: providers.judge,
					threshold: 0.6,
					logger,
				}),
			} satisfies Partial<AgentServer>,
		});
	// A runtime is given whole: a class's private members do not survive the partial service's proxy.
	for (const { key, given: members } of given.values())
		services.preset(
			key,
			key.id === RUNTIME.id ? members : partialService(key, members),
		);
	// The turns nobody wrote run through the same router, unless the test gave others or the plugin provides them.
	if (
		!given.has(BACKGROUND_TURNS.id) &&
		!plugin.provides?.some((key) => key.id === BACKGROUND_TURNS.id)
	)
		services.preset(
			BACKGROUND_TURNS,
			new ConversationBackgroundTurns({
				conversations,
				system: { id: "assistant", name: "Assistant" },
				logger,
			}),
		);
	services.checkRequires();
	const context: Omit<PluginContext, "services" | "directChannels"> = {
		logger,
		env,
		sessions: () => linked ?? unlinked("sessions"),
		queue,
		toolTiers: tiers,
		events: sink,
		conversations,
		surfaces,
		turns,
		database: () => {
			if (!options.database) throw new PluginError("no database is configured");
			return options.database;
		},
		providers,
		dashboard: () => (linked ? registry.dashboard : unlinked("dashboard")),
		apiKey: async (provider) =>
			Object.hasOwn(options.apiKeys ?? {}, provider)
				? options.apiKeys?.[provider]
				: undefined,
	};
	const registry = await collectContributions(
		[plugin],
		context,
		tiers,
		services,
	);
	linked = linkSessions(registry);
	bus.link(registry.handlers);
	// With a team given, the agent server's claim and its target are in the router, as on a host.
	const team = given.get(AGENTS.id)?.given;
	const agentServer = team && "team" in team ? services.get(AGENTS) : undefined;
	const attachmentDir = mkdtempSync(join(tmpdir(), "roundtable-test-plugin-"));
	const identity = services.find(IDENTITY);
	// Who wrote a message, and whom a background turn runs as: by the given IDENTITY, else the owner alone, at the owner tier.
	const people = mapIdentity({ owners: [owner.id] });
	router = new ChannelRouter({
		contacts: identity ? contactsOf(identity) : people,
		principals: identity ?? people,
		claims: [
			...(agentServer
				? [
						agentClaim({
							owner,
							// SAFETY: the claim reads the concrete team's members (guildId, owns, answerOwner, answerGroup, answerBackground, startFresh), which a test that gives a team for it supplies.
							team: agentServer.team as unknown as Parameters<
								typeof agentClaim
							>[0]["team"],
							runtime: {
								steer: (...args) => services.get(AGENTS).runtime.steer(...args),
								stop: (channel) => services.get(AGENTS).runtime.stop(channel),
							},
							surface: surfaces,
							attachmentDir: () => attachmentDir,
							logger,
						}),
					]
				: []),
			...registry.channels,
		],
		targets: (name) =>
			registry.backgroundTargets.find((t) => t.name === name) ??
			(agentServer && name === PERSONAL_TARGET.name
				? PERSONAL_TARGET
				: undefined),
		queue,
		logger,
		...(options.forwardJoinMs === undefined
			? {}
			: { forwardJoinMs: options.forwardJoinMs }),
	});
	const contribution: Contribution = {
		services: registry.services,
		events: registry.handlers[0]?.events,
		http: registry.routes,
		holdRules: registry.holdRules,
		piPackages: registry.piPackages,
		sessionTools: registry.sessionTools,
		channels: registry.channels,
		surfaces: registry.surfaces,
		personas: registry.personas,
		backgroundTargets: registry.backgroundTargets,
		dashboard: registry.dashboard,
		tools: registry.tools,
		seeds: registry.seeds,
		prompt: registry.prompt,
		requiredTools: registry.requiredTools,
		...(registry.agentSelections.length > 0
			? { agentSelection: linked.agentSelection }
			: {}),
	};
	// The plugin's own surfaces start as services; the injected ones start beside them, after.
	const deliver = (message: InboundMessage) =>
		void conversations.handle(message);
	for (const service of registry.services) await service.start?.();
	for (const surface of options.surfaces ?? []) await surface.start(deliver);
	await runtime?.preflight?.();
	let stopped = false;
	const files: { channel: ChannelKey; file: ReplyFile }[] = [];
	return {
		contribution,
		holds: linked.holds,
		conversations,
		turns,
		surfaces,
		runtime,
		tools: registry.tools.map((tool) => tool.name),
		tiers,
		events,
		files,
		async runTool(name, args, runOptions) {
			const tool = registry.tools.find((item) => item.name === name);
			if (!tool) throw new PluginError(`tool ${name} is not registered`);
			const registered: {
				execute(
					id: string,
					params: Record<string, unknown>,
					signal?: AbortSignal,
				): Promise<{
					content: readonly { type: string; text?: string }[];
					isError?: boolean;
				}>;
			}[] = [];
			const channel = runOptions?.channel ?? "test:1";
			const session = {
				kind: "agent",
				homeChannel: channel,
				turnChannel: channel,
				compaction: { wrap: (factory) => factory },
				conversation: { visibility: "shared" },
				addressee: THE_SPEAKER,
				memory: "speaker",
				speaker: () => runOptions?.speaker,
				runTask: async () => {
					throw new Error("test session cannot run tasks");
				},
			} satisfies SessionContext;
			const factory = tool.session.snapshot().factory(session);
			// SAFETY: defineTool's session factory only calls registerTool; the fake captures its definition.
			factory?.({
				registerTool: (definition: (typeof registered)[number]) => {
					registered.push(definition);
				},
			} as unknown as ExtensionAPI);
			const execute = registered[0]?.execute;
			if (!execute)
				throw new PluginError(`tool ${name} did not register in the session`);
			const result = await withReplyFiles(
				surfaces.of(channel)?.supportsFiles === true,
				async () => {
					const output = await execute("test-call", args);
					return {
						ok: true,
						text: output.content.map((item) => item.text ?? "").join("\n"),
					};
				},
			);
			if (!result.ok) throw result.error;
			for (const file of result.files ?? []) {
				files.push({ channel, file });
				// When runTool is used by a fake runtime, forward into the enclosing real turn.
				if (hasReplyFileScope()) attachReplyFile(file);
			}
			return result.text;
		},
		async stop() {
			if (stopped) return;
			stopped = true;
			await bus.deliver("shutdown", []);
			for (const surface of (options.surfaces ?? []).toReversed())
				await surface.stop?.();
			for (const service of registry.services.toReversed())
				await service.stop?.();
			await runtime?.dispose?.();
		},
	};
}
