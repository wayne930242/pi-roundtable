import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG } from "./characters/index.ts";
import { agentClaim } from "./core/agents/agent-claim.ts";
import { ownerAttachmentDir } from "./core/attachments/attachment-dir.ts";
import { attachmentPort } from "./core/attachments/attachment-port.ts";
import { DISCORD, type DiscordServices } from "./core/builtin/discord.ts";
import type { InboundMessage } from "./core/contract/channels.ts";
import type { Providers } from "./core/contract/providers.ts";
import type { AgentRuntime, RuntimeDeps } from "./core/contract/runtime.ts";
import { supportOf } from "./core/domain/block-support.ts";
import type { ClientPart } from "./core/domain/client.ts";
import type { ReplyFile } from "./core/domain/conversation.ts";
import type { ChannelKey, SessionContext } from "./core/domain/sessions.ts";
import { EventBus } from "./core/host/events.ts";
import { listenerAddress } from "./core/http/listeners.ts";
import { contactsOf } from "./core/identity/identity-view.ts";
import { THE_SPEAKER } from "./core/identity/speakers.ts";
import { ConfirmationJudge } from "./core/judging/confirmation-judge.ts";
import { PluginError } from "./core/kernel/errors.ts";
import { silentLogger } from "./core/kernel/log.ts";
import { ConversationBackgroundTurns } from "./core/modules/background/background-turns.ts";
import type {
	Contribution,
	HostEnv,
	LinkedSessions,
	RoundtablePlugin,
	TurnEndEvent,
	TurnEvent,
	TurnProgressEvent,
} from "./core/plugin-api/plugin.ts";
import {
	AGENTS,
	type AgentServer,
	BACKGROUND_TURNS,
	CONVERSATIONS,
	IDENTITY,
	RUNTIME,
} from "./core/plugin-api/services.ts";
import {
	type ContributionBase,
	collectContributions,
	linkSessions,
} from "./core/registry/contributions.ts";
import { resolveProviders } from "./core/registry/providers.ts";
import { ServiceRegistry } from "./core/registry/services.ts";
import { ChannelQueue } from "./core/routing/channel-queue.ts";
import { ChannelRouter } from "./core/routing/channel-router.ts";
import {
	type ConversationTurns,
	conversationTurns,
} from "./core/routing/conversation-turns.ts";
import { MessageObservers } from "./core/routing/message-observers.ts";
import { PeerBots } from "./core/routing/peer-bots.ts";
import { surfacePort } from "./core/routing/surface-port.ts";
import { toolTiers } from "./core/runtime/tool-tiers.ts";
import { PERSONAL_TARGET } from "./core/shared/personal-target.ts";
import { mapIdentity } from "./core/testing/map-identity.ts";
import { memberOf } from "./core/testing/partial.ts";
import {
	memoryHeldActions,
	partialService,
	routedConversations,
	unlinked,
} from "./core/testing/plugin-stand-ins.ts";
import {
	callRegisteredTool,
	registeredTools,
} from "./core/testing/run-tool.ts";
import type {
	RecordedEvent,
	TestPluginOptions,
	TestPluginResult,
} from "./core/testing/test-plugin-types.ts";

// Fixtures for plugin tests.

export { silentLogger } from "./core/kernel/log.ts";
export type { TestStore } from "./core/testing/database.ts";
export {
	describeDb,
	openTestStore,
	requireDatabase,
	TEST_GUILD,
	testDatabaseUrl,
} from "./core/testing/database.ts";
export { eagerText, useEagerCatalog } from "./core/testing/eager-catalog.ts";
export type { FakeDiscord } from "./core/testing/fake-discord.ts";
export { fakeDiscord } from "./core/testing/fake-discord.ts";
export type {
	FakeDiscordPoster,
	FakeForum,
	FakePosterChannel,
	FakePosterMessage,
	FakeRoleChange,
} from "./core/testing/fake-poster.ts";
export { fakeDiscordPoster } from "./core/testing/fake-poster.ts";
export type { TestLocale } from "./core/testing/locale.ts";
export { useTestLocale } from "./core/testing/locale.ts";
export { OWNER_SPEAKER } from "./core/testing/owner.ts";
export { partial } from "./core/testing/partial.ts";
export type {
	PlaceContractFailure,
	PlaceContractSubject,
	PlaceSeen,
} from "./core/testing/place-contract.ts";
export {
	checkPlaceProviderContract,
	placeProviderContract,
} from "./core/testing/place-contract.ts";
export type { UsePostgresOptions } from "./core/testing/postgres.ts";
export { usePostgresForTests } from "./core/testing/postgres.ts";
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
export type { ServicePair } from "./core/testing/service-pair.ts";
export { servicePair } from "./core/testing/service-pair.ts";
export type {
	SurfaceContractAnswerer,
	SurfaceContractFailure,
	SurfaceContractSubject,
	SurfaceObservation,
} from "./core/testing/surface-contract.ts";
export {
	checkSurfaceContract,
	describeBlocksContract,
	describeSurfaceContract,
} from "./core/testing/surface-contract.ts";
export type { TestHost, TestHostOptions } from "./core/testing/test-host.ts";
export { testHost } from "./core/testing/test-host.ts";
export type {
	RecordedEvent,
	TestPluginOptions,
	TestPluginResult,
} from "./core/testing/test-plugin-types.ts";
export type { FakeThreadHost } from "./core/testing/thread-host.ts";
export { fakeThreads } from "./core/testing/thread-host.ts";

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
	const conversations = routedConversations(
		() => router,
		options.conversations,
	);
	const surfaces = surfacePort(() =>
		linked
			? [...registry.surfaces, ...(options.surfaces ?? [])]
			: unlinked("surfaces"),
	);
	const observers = new MessageObservers(logger, () => surfaces.roomSurfaces());
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
		characterSkins: CATALOG.skins,
		agentTools: "full",
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
			formatting: (c) => supportOf(surfaces.of(c), c).formatting,
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
	const attachmentDir = mkdtempSync(join(tmpdir(), "roundtable-test-plugin-"));
	const context: ContributionBase = {
		logger,
		env,
		sessions: () => linked ?? unlinked("sessions"),
		queue,
		toolTiers: tiers,
		events: sink,
		conversations,
		attachments: attachmentPort({
			dataDir: attachmentDir,
			registry: () => services.find(CONVERSATIONS),
			logger,
		}),
		surfaces,
		turns,
		observe: (filter, observer) => observers.add(filter, observer),
		database: () => {
			if (!options.database) throw new PluginError("no database is configured");
			return options.database;
		},
		providers,
		dashboard: () => (linked ? registry.dashboard : unlinked("dashboard")),
		chatCommands: () =>
			linked ? registry.chatCommandSources.listed() : unlinked("chatCommands"),
		apiKey: async (provider) =>
			Object.hasOwn(options.apiKeys ?? {}, provider)
				? options.apiKeys?.[provider]
				: undefined,
		listener: (id) => listenerAddress(options.listeners ?? [], id),
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
							discordGuild: memberOf(agentServer.team, "discordGuild"),
							// SAFETY: the claim reads the concrete team's members (owns, answerOwner, answerGroup, answerBackground, startFresh), which a test that gives a team for it supplies.
							team: agentServer.team as never,
							runtime: {
								steer: (...args) => services.get(AGENTS).runtime.steer(...args),
								stop: (channel) => services.get(AGENTS).runtime.stop(channel),
							},
							surface: surfaces,
							attachmentDir: () => attachmentDir,
							logger,
							// As on a host: the given DISCORD's channel context, when the test gives one.
							channelContext: async (message) =>
								(
									given.get(DISCORD.id)?.given as
										| Partial<DiscordServices>
										| undefined
								)?.channelContext?.(message),
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
		observers,
		...(options.peerBots ? { peerBots: new PeerBots(options.peerBots) } : {}),
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
		chatCommands: registry.chatCommands,
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
	// As the host does, the plugin's preflight runs once everything is set up and before any service
	// starts, and the runtime's own after it, so it sees what the preflight filled in.
	try {
		await plugin.preflight?.();
		await runtime?.preflight?.();
	} catch (error) {
		// The runtime the provider built is not left running when the plugin or the runtime refuses.
		await runtime?.dispose?.();
		throw error;
	}
	for (const service of registry.services) await service.start?.();
	for (const surface of options.surfaces ?? [])
		await surface.start(deliver, {
			deleted: (channel, id, space) =>
				void conversations.messageDeleted?.(channel, id, space),
			edited: (message) => void conversations.messageEdited?.(message),
		});
	let stopped = false;
	const files: { channel: ChannelKey; file: ReplyFile }[] = [];
	const images: { channel: ChannelKey; image: ClientPart }[] = [];
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
		images,
		async runTool(name, args, runOptions) {
			const tool = registry.tools.find((item) => item.name === name);
			if (!tool) throw new PluginError(`tool ${name} is not registered`);
			const channel = runOptions?.channel ?? "test:1";
			const session = {
				kind: "agent",
				homeChannel: channel,
				turnChannel: channel,
				compaction: { wrap: (factory) => factory },
				conversation: { visibility: "shared" },
				addressee: THE_SPEAKER,
				memory: "speaker",
				...(runOptions?.workspace ? { workspace: runOptions.workspace } : {}),
				attachmentDir: ownerAttachmentDir(attachmentDir, channel),
				speaker: () => runOptions?.speaker,
				origin: () => runOptions?.origin,
				client: () => runOptions?.client,
				runTask: async () => {
					throw new Error("test session cannot run tasks");
				},
			} satisfies SessionContext;
			const [registered] = await registeredTools(
				tool.session.snapshot().factory(session),
			);
			if (!registered)
				throw new PluginError(`tool ${name} did not register in the session`);
			const result = await callRegisteredTool(
				registered,
				args,
				surfaces.of(channel)?.supportsFiles === true,
			);
			for (const image of result.images) images.push({ channel, image });
			for (const file of result.files) files.push({ channel, file });
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
