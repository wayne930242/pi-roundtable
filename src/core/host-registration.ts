import type { SQL } from "bun";
import {
	CATALOG,
	CharacterError,
	checkSkins,
	type Hex,
} from "../characters/index.ts";
import { attachmentPort } from "./attachments/attachment-port.ts";
import { retentionServices } from "./attachments/attachment-retention.ts";
import type { AttachmentPort } from "./contract/attachments.ts";
import type { ConversationPort } from "./contract/channels.ts";
import type { ResolvedProviders } from "./contract/providers.ts";
import type { SurfacePort } from "./contract/surface.ts";
import { ConfigError } from "./domain/errors.ts";
import { NotLinkedError } from "./errors.ts";
import { EventBus } from "./events.ts";
import type { RoundtableOptions } from "./host.ts";
import { HttpListeners, listenerAddress } from "./http/listeners.ts";
import { setLocale } from "./i18n/index.ts";
import { contactsOf } from "./identity/identity-view.ts";
import type {
	HostEnv,
	LinkedSessions,
	RoundtablePlugin,
	Service,
} from "./plugin.ts";
import { refuseRemovedFields } from "./plugin.ts";
import {
	collectContributions,
	emptyRegistry,
	linkSessions,
	type Registry,
} from "./registry/contributions.ts";
import { resolveProviders } from "./registry/providers.ts";
import { replaceServices, ServiceRegistry } from "./registry/services.ts";
import { ChannelQueue } from "./routing/channel-queue.ts";
import { ChannelRouter } from "./routing/channel-router.ts";
import {
	type ConversationTurns,
	conversationTurns,
} from "./routing/conversation-turns.ts";
import { MessageObservers } from "./routing/message-observers.ts";
import { PeerBots } from "./routing/peer-bots.ts";
import { surfacePort } from "./routing/surface-port.ts";
import { refuseHostAccess } from "./runtime/chat-only.ts";
import { CONVERSATIONS, IDENTITY, RUNTIME } from "./services.ts";
import { setTimeZone } from "./time.ts";
import { type ToolTierTable, toolTiers } from "./tool-tiers.ts";

/** The skin tones the host's environment names, checked, or the package's own; a bad set refuses the start. */
function characterSkinsOf(skins: readonly Hex[] | undefined): readonly Hex[] {
	if (skins === undefined) return CATALOG.skins;
	try {
		return checkSkins(skins, "environment.characterSkins");
	} catch (error) {
		if (error instanceof CharacterError)
			throw new ConfigError(
				`${error.message}. Pass exactly six #rrggbb colors, such as EAST_ASIAN_SKINS from pi-roundtable/characters.`,
			);
		throw error;
	}
}

/**
 * What `Roundtable.check()` found: the plugins that would run, the services and HTTP routes they
 * add, as the host would start them.
 */
export interface RegistrationReport {
	/** The plugins that would run, in set-up order (after replacements). */
	plugins: readonly string[];
	/** The services they contribute, in start order. */
	services: readonly string[];
	/** Their HTTP routes, as `<listener> <path>`. */
	routes: readonly string[];
}

/** What the plugins' registration leaves for the host to start: the listeners it validated and the retention services. */
export interface Linked {
	http: HttpListeners;
	retention: Service[];
}

/**
 * The host's registration of its plugins: set up every plugin, link what they add, and refuse any
 * clash, before a service starts or a listener opens. `run()` and `check()` share it; they differ
 * only in the database the plugins' setup sees.
 */
export class Linkage {
	readonly queue = new ChannelQueue();
	/** The plugins' passive message observers, shared by the router and `context.observe`. */
	readonly observers: MessageObservers;
	readonly events: EventBus;
	readonly tiers: ToolTierTable;
	registry: Registry = emptyRegistry();
	sessions: LinkedSessions | undefined;
	router: ChannelRouter | undefined;
	services: ServiceRegistry | undefined;
	/** The plugins that run: the registered ones, less those a replacement dropped, in set-up order. */
	active: readonly RoundtablePlugin[] = [];
	readonly #options: RoundtableOptions;
	readonly #plugins: readonly RoundtablePlugin[];
	readonly #warned = new Set<string>();
	#prepared:
		| {
				env: HostEnv;
				providers: ResolvedProviders;
				attachments: AttachmentPort;
				retention: Service[];
		  }
		| undefined;

	constructor(
		options: RoundtableOptions,
		plugins: readonly RoundtablePlugin[],
	) {
		this.#options = options;
		this.#plugins = plugins;
		this.tiers = options.toolTiers ?? toolTiers();
		this.events = new EventBus(options.logger);
		this.observers = new MessageObservers(options.logger, () =>
			this.#surfaces().roomSurfaces(),
		);
	}

	/** Applies the host's environment to the process and returns what plugins read of it. */
	#applyEnvironment(): HostEnv {
		const {
			locale = "en",
			timeZone = "UTC",
			assistant = "Roundtable",
			rootCommand = "roundtable",
			agentDir,
			scratchDir,
			characterSkins,
			agentTools = "full",
		} = this.#options.environment ?? {};
		// Checked before anything is applied, so a bad set stops the start with the process untouched.
		const skins = characterSkinsOf(characterSkins);
		setLocale(locale, { assistant, root: rootCommand });
		setTimeZone(timeZone);
		// Pi packages such as pi-web-access read their config from the Pi agent directory.
		if (agentDir !== undefined) process.env.PI_CODING_AGENT_DIR = agentDir;
		return {
			locale,
			timeZone,
			now: () => new Date(),
			...(scratchDir !== undefined ? { scratchDir } : {}),
			characterSkins: skins,
			agentTools,
		};
	}

	/** Applies the environment and settles which plugins run and what they require, before any migration or setup. */
	prepare(): void {
		const { logger } = this.#options;
		for (const plugin of this.#plugins) refuseRemovedFields(plugin);
		const env = this.#applyEnvironment();
		// A plugin that replaces a service takes the place of the one that provided it.
		this.active = replaceServices(this.#plugins);
		if (env.agentTools === "chat-only") refuseHostAccess(this.active);
		this.services = new ServiceRegistry(this.active);
		this.services.checkRequires();
		const providers = resolveProviders(this.active, this.#options.judgeModel);
		const attachments = attachmentPort({
			dataDir: this.#options.dataDir,
			registry: () => this.services?.find(CONVERSATIONS),
			logger,
		});
		const retention = retentionServices(
			this.#options.attachments?.retention,
			this.#options.dataDir,
			attachments,
			logger,
		);
		this.#prepared = { env, providers, attachments, retention };
	}

	/**
	 * Sets up every plugin over `database`, links the session parts, builds the router and validates
	 * the routes against the listeners, without opening one.
	 */
	async link(database: () => SQL): Promise<Linked> {
		const { logger, listeners = [] } = this.#options;
		const prepared = this.#prepared;
		const { services } = this;
		if (!prepared || !services)
			throw new NotLinkedError("the plugins are prepared before they link.");
		this.registry = await collectContributions(
			this.active,
			{
				logger,
				env: prepared.env,
				sessions: () => {
					if (!this.sessions)
						throw new NotLinkedError(
							"session parts are linked once every plugin is set up. Call sessions() from a service's start or from a handler, not during setup.",
						);
					return this.sessions;
				},
				queue: this.queue,
				toolTiers: this.tiers,
				events: this.events.sink,
				conversations: this.#conversations(),
				attachments: prepared.attachments,
				surfaces: this.#surfaces(),
				turns: this.#turns(),
				database,
				providers: prepared.providers,
				dashboard: () => {
					if (!this.sessions)
						throw new NotLinkedError(
							"dashboard lines are linked once every plugin is set up. Call dashboard() from a service's start or from a handler, not during setup.",
						);
					return this.registry.dashboard;
				},
				observe: (filter, observer) => this.observers.add(filter, observer),
				apiKey: async (provider) => this.#options.apiKey?.(provider),
				listener: (id) => listenerAddress(listeners, id),
			},
			this.tiers,
			services,
		);
		const { routes, channels } = this.registry;
		this.sessions = linkSessions(this.registry);
		this.events.link(this.registry.handlers);
		const identity = services.find(IDENTITY);
		this.router = new ChannelRouter({
			claims: channels,
			...(identity
				? { contacts: contactsOf(identity), principals: identity }
				: {}),
			targets: (name) =>
				this.registry.backgroundTargets.find((t) => t.name === name),
			queue: this.queue,
			surfaces: this.#surfaces(),
			logger,
			observers: this.observers,
			...(this.#options.peerBots
				? { peerBots: new PeerBots(this.#options.peerBots) }
				: {}),
			...(this.#options.conversations?.forwardJoinMs === undefined
				? {}
				: { forwardJoinMs: this.#options.conversations.forwardJoinMs }),
		});
		return {
			http: new HttpListeners(listeners, routes, logger),
			retention: prepared.retention,
		};
	}

	/** What the plugins added, as `check()` reports it. */
	report(): RegistrationReport {
		return {
			plugins: this.active.map((plugin) => plugin.name),
			services: this.registry.services.map((service) => service.name),
			routes: this.registry.routes.map(
				(route) =>
					`${route.listener} ${"exact" in route.path ? route.path.exact : route.path.prefix}`,
			),
		};
	}

	/** The claimed channels' conversations; every call before linking throws NotLinkedError. */
	#conversations(): ConversationPort {
		const router = () => {
			if (!this.router)
				throw new NotLinkedError(
					"conversations are linked once every plugin is set up. Use them from a service's start or from a handler, not during setup.",
				);
			return this.router;
		};
		return {
			handle: (message) => router().handle(message),
			messageDeleted: (channel, id, space) =>
				router().messageDeleted(channel, id, space),
			messageEdited: (message) => router().messageEdited(message),
			background: (turn) => router().background(turn),
			runsAs: (turn) => router().runsAs(turn),
			target: (name) => router().target(name),
			startFresh: (channel) => router().startFresh(channel),
			deleteConversation: (channel) => router().deleteConversation(channel),
			stop: (channel) => router().stop(channel),
			postsInPlace: (channel) => router().postsInPlace(channel),
			owns: (channel) => router().owns(channel),
			takesBackground: (channel) => router().takesBackground(channel),
			takesSystemReports: (channel) => router().takesSystemReports(channel),
		};
	}

	/** The contributed surfaces by channel prefix; every call before linking throws NotLinkedError. */
	#surfaces(): SurfacePort {
		return surfacePort(
			() => {
				if (!this.sessions)
					throw new NotLinkedError(
						"chat surfaces are linked once every plugin is set up. Use surfaces from a service's start or from a handler, not during setup.",
					);
				return this.registry.surfaces;
			},
			{ deprecated: (message) => this.#deprecated(message) },
		);
	}

	/** Logs a deprecation once per host. */
	#deprecated(message: string): void {
		if (this.#warned.has(message)) return;
		this.#warned.add(message);
		this.#options.logger.warn(message);
	}

	/** Turns over the runtime plugin's runtime and the surfaces; every call before linking is refused with NotLinkedError. */
	#turns(): ConversationTurns {
		return conversationTurns({
			linked: () => {
				if (!this.sessions)
					throw new NotLinkedError(
						"conversation turns are linked once every plugin is set up. Use turns from a service's start or from a handler, not during setup.",
					);
			},
			runtime: () => {
				if (!this.services)
					throw new NotLinkedError("the host has not started yet.");
				return this.services.get(RUNTIME);
			},
			registry: () => this.services?.find(CONVERSATIONS),
			surfaces: this.#surfaces(),
			events: this.events.sink,
			stopping: () => this.queue.closed,
			selection: () => {
				if (!this.sessions)
					throw new NotLinkedError("session parts are not linked yet.");
				return this.sessions.agentSelection();
			},
			logger: this.#options.logger,
		});
	}
}
