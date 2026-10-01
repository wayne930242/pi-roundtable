import type { SQL } from "bun";
import type { ConversationPort } from "./contract/channels.ts";
import type { SurfacePort } from "./contract/surface.ts";
import { openPool, runMigrations } from "./db/migrations.ts";
import { type DrainOptions, waitUntilIdle } from "./drain.ts";
import { MigrationError, NotLinkedError, PluginError } from "./errors.ts";
import { EventBus } from "./events.ts";
import { HttpListeners, type ListenerConfig } from "./http/listeners.ts";
import { type Locale, setLocale } from "./i18n/index.ts";
import type { JudgeModel } from "./judging/model-judge.ts";
import type { Logger } from "./log.ts";
import type {
	HostEnv,
	LinkedSessions,
	RoundtablePlugin,
	Service,
	ServiceStartedEvent,
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
import { surfacePort } from "./routing/surface-port.ts";
import { AGENTS } from "./services.ts";
import { setTimeZone } from "./time.ts";
import { type ToolTierTable, toolTiers } from "./tool-tiers.ts";

/**
 * What differs between hosts: the words and time the process speaks in, and the Pi agent
 * directory its packages read. `run()` applies them to the process when the host starts, and
 * plugins read the locale and zone from `PluginContext.env`.
 */
export interface HostEnvironment {
	/** The language of the Discord text; default en. */
	locale?: Locale;
	/** An IANA time zone; default UTC. */
	timeZone?: string;
	/** The assistant's display name in the text; default Roundtable. */
	assistant?: string;
	/** The name of the root slash command in the text, without the slash; default roundtable. */
	rootCommand?: string;
	/** Exported as `PI_CODING_AGENT_DIR` for Pi packages such as pi-web-access; unset leaves the process's own. */
	agentDir?: string;
}

export interface RoundtableOptions {
	logger: Logger;
	/** The host's locale, time zone and names. Nothing is applied before `run()`. */
	environment?: HostEnvironment;
	/** The HTTP listeners plugins attach routes to. */
	listeners?: readonly ListenerConfig[];
	/** How long a bare forward waits for the message it follows. */
	conversations?: {
		forwardJoinMs?: number;
	};
	/** The model the default judge asks, when no plugin provides a judge. */
	judgeModel?: JudgeModel;
	/**
	 * The credential the model login holds for a provider, or undefined when it holds none; behind
	 * `PluginContext.apiKey`. Without it every provider reads as having no credential.
	 */
	apiKey?: (provider: string) => Promise<string | undefined>;
	/** What each tool needs: the operator's settings, with the plugins' tools added when the host links. */
	toolTiers?: ToolTierTable;
	/** The database the plugins' migrations and stores use; the host owns its one pool. */
	database?: { url: string };
	/** Receives the work a shutdown drain gave up on, before any service stops. */
	aborted?: (left: string[]) => Promise<void>;
	/** The drain's limit and clock; tests shorten them. */
	drain?: Omit<DrainOptions, "busy">;
	/** What `listen()` calls with the shutdown's exit code; the process's own exit by default. */
	exit?: (code: number) => void;
}

/** The host running in this process; the text catalog, time zone and environment are process-wide. */
let running: Roundtable | undefined;

type Attempt = { ok: true } | { ok: false; error: unknown };

/** Runs one step whose failure the caller reports and moves past. */
async function attempt(step: () => Promise<void> | void): Promise<Attempt> {
	try {
		await step();
		return { ok: true };
	} catch (error) {
		return { ok: false, error };
	}
}

/**
 * Runs every service's background start at once and tells every plugin, as each ends, how it
 * went; the rest of the process runs either way, and a failing start or handler never stops the
 * others.
 */
async function startInBackground(
	registry: Registry,
	logger: Logger,
): Promise<void> {
	const { services, servicePlugins, handlers } = registry;
	await Promise.all(
		services.map(async (service) => {
			if (!service.startInBackground) return;
			const plugin = servicePlugins.get(service) ?? "unknown";
			const started = await attempt(() => service.startInBackground?.());
			if (started.ok) logger.info({ plugin, service: service.name }, "ready");
			else
				logger.error(
					{ plugin, service: service.name, err: started.error },
					"service did not start in the background",
				);
			const event: ServiceStartedEvent = {
				plugin,
				service: service.name,
				outcome: started.ok ? "ready" : "failed",
			};
			for (const { plugin: heard, events } of handlers) {
				const handled = await attempt(() => events.serviceStarted?.(event));
				if (!handled.ok)
					logger.error(
						{ plugin: heard, err: handled.error },
						"service started handler failed",
					);
			}
		}),
	);
}

/**
 * The process around the plugins: it sets them all up, links what they add (session parts,
 * HTTP routes) and runs the preflight, then starts their services in order and the
 * HTTP listeners last, then runs the services' background starts. Nothing reaches Discord or a listener unless
 * every setup, link, and the preflight succeeded. On shutdown it waits until no work runs or
 * waits before closing the listeners and stopping the services in reverse.
 */
// pi-lens-ignore: large-class
export class Roundtable {
	readonly #options: RoundtableOptions;
	readonly #plugins: readonly RoundtablePlugin[];
	#registry: Registry = emptyRegistry();
	#sessions: LinkedSessions | undefined;
	#router: ChannelRouter | undefined;
	#listeners: HttpListeners | undefined;
	#pool: SQL | undefined;
	readonly #queue = new ChannelQueue();
	readonly #tiers: ToolTierTable;
	readonly #events: EventBus;
	#services: ServiceRegistry | undefined;
	/** The plugins that run: the registered ones, less those a replacement dropped, in set-up order. */
	#active: readonly RoundtablePlugin[] = [];
	/** The services whose start finished, in start order. */
	#started: Service[] = [];
	#booting: Promise<void> | undefined;
	#bootFailed = false;
	#stopping: Promise<number> | undefined;

	constructor(
		options: RoundtableOptions,
		plugins: readonly RoundtablePlugin[],
	) {
		if ("commands" in options)
			throw new PluginError(
				"RoundtableOptions.commands was removed in 0.2.0; the host composes no commands. The Discord plugin composes them under the root command named by config discord.rootCommand, and a plugin adds its own with context.services.get(DISCORD).commands.add(...), with DISCORD from pi-roundtable/discord.",
			);
		this.#options = options;
		this.#plugins = plugins;
		this.#tiers = options.toolTiers ?? toolTiers();
		this.#events = new EventBus(options.logger);
	}

	/** The claimed channels' conversations; every call before linking throws NotLinkedError. */
	#conversations(): ConversationPort {
		const router = () => {
			if (!this.#router)
				throw new NotLinkedError(
					"conversations are linked once every plugin is set up. Use them from a service's start or from a handler, not during setup.",
				);
			return this.#router;
		};
		return {
			handle: (message) => router().handle(message),
			background: (turn) => router().background(turn),
			target: (name) => router().target(name),
			startFresh: (channel) => router().startFresh(channel),
			deleteConversation: (channel) => router().deleteConversation(channel),
			stop: (channel) => router().stop(channel),
			postsInPlace: (channel) => router().postsInPlace(channel),
		};
	}

	/** The contributed surfaces by channel prefix; every call before linking throws NotLinkedError. */
	#surfaces(): SurfacePort {
		return surfacePort(() => {
			if (!this.#sessions)
				throw new NotLinkedError(
					"chat surfaces are linked once every plugin is set up. Use surfaces from a service's start or from a handler, not during setup.",
				);
			return this.#registry.surfaces;
		});
	}

	/** Turns over the agent server's runtime and the surfaces; every call before linking is refused with NotLinkedError. */
	#turns(): ConversationTurns {
		return conversationTurns({
			linked: () => {
				if (!this.#sessions)
					throw new NotLinkedError(
						"conversation turns are linked once every plugin is set up. Use turns from a service's start or from a handler, not during setup.",
					);
			},
			runtime: () => {
				if (!this.#services)
					throw new NotLinkedError("the host has not started yet.");
				return this.#services.get(AGENTS).runtime;
			},
			surfaces: this.#surfaces(),
			events: this.#events.sink,
			selection: () => {
				if (!this.#sessions)
					throw new NotLinkedError("session parts are not linked yet.");
				return this.#sessions.agentSelection();
			},
			logger: this.#options.logger,
		});
	}

	/**
	 * Sets up every plugin, links what they add and runs the preflight, refusing any clash before
	 * anything starts, then starts the services and opens the listeners; the agent server starts
	 * in the background. One host runs per process: a second `run()` is refused until the first
	 * host has stopped. A start that fails stops what it started, in reverse, closes the pool,
	 * and rethrows, so the same host may try again.
	 */
	async run(): Promise<void> {
		if (running)
			throw new PluginError(
				"a Roundtable host is already running in this process. Stop the first host, or run this one in a separate process.",
			);
		running = this;
		this.#stopping = undefined;
		this.#bootFailed = false;
		this.#booting = this.#boot();
		try {
			await this.#booting;
		} catch (error) {
			this.#bootFailed = true;
			await this.#teardown();
			running = undefined;
			throw error;
		}
	}

	/** Applies the host's environment to the process and returns what plugins read of it. */
	#applyEnvironment(): HostEnv {
		const {
			locale = "en",
			timeZone = "UTC",
			assistant = "Roundtable",
			rootCommand = "roundtable",
			agentDir,
		} = this.#options.environment ?? {};
		setLocale(locale, { assistant, root: rootCommand });
		setTimeZone(timeZone);
		// Pi packages such as pi-web-access read their config from the Pi agent directory.
		if (agentDir !== undefined) process.env.PI_CODING_AGENT_DIR = agentDir;
		return { locale, timeZone, now: () => new Date() };
	}

	async #boot(): Promise<void> {
		const { logger, listeners = [] } = this.#options;
		for (const plugin of this.#plugins) refuseRemovedFields(plugin);
		const env = this.#applyEnvironment();
		// A plugin that replaces a service takes the place of the one that provided it.
		this.#active = replaceServices(this.#plugins);
		this.#services = new ServiceRegistry(this.#active);
		this.#services.checkRequires();
		const providers = resolveProviders(this.#active, this.#options.judgeModel);
		await this.#migrate();
		this.#registry = await collectContributions(
			this.#active,
			{
				logger,
				env,
				sessions: () => {
					if (!this.#sessions)
						throw new NotLinkedError(
							"session parts are linked once every plugin is set up. Call sessions() from a service's start or from a handler, not during setup.",
						);
					return this.#sessions;
				},
				queue: this.#queue,
				toolTiers: this.#tiers,
				events: this.#events.sink,
				conversations: this.#conversations(),
				surfaces: this.#surfaces(),
				turns: this.#turns(),
				database: () => {
					if (!this.#pool) throw new PluginError("no database is configured");
					return this.#pool;
				},
				providers,
				dashboard: () => {
					if (!this.#sessions)
						throw new NotLinkedError(
							"dashboard lines are linked once every plugin is set up. Call dashboard() from a service's start or from a handler, not during setup.",
						);
					return this.#registry.dashboard;
				},
				apiKey: async (provider) => this.#options.apiKey?.(provider),
			},
			this.#tiers,
			this.#services,
		);
		const { routes, channels } = this.#registry;
		this.#sessions = linkSessions(this.#registry);
		this.#events.link(this.#registry.handlers);
		this.#router = new ChannelRouter({
			claims: channels,
			targets: (name) =>
				this.#registry.backgroundTargets.find((t) => t.name === name),
			queue: this.#queue,
			logger,
			...(this.#options.conversations?.forwardJoinMs === undefined
				? {}
				: { forwardJoinMs: this.#options.conversations.forwardJoinMs }),
		});
		const http = new HttpListeners(listeners, routes, logger);
		for (const plugin of this.#active) await plugin.preflight?.();
		for (const service of this.#registry.services) {
			await service.start?.();
			this.#started.push(service);
		}
		// Requests arrive only once everything they may reach is running.
		this.#listeners = http;
		http.start();
		// After the listeners, so a background start may rely on everything else running.
		void startInBackground(this.#registry, logger);
	}

	/** Opens the pool and runs every plugin's migrations; a failure closes it again and stops the boot. */
	async #migrate(): Promise<void> {
		const migrations = this.#active.flatMap(
			(plugin) => plugin.migrations ?? [],
		);
		const { database } = this.#options;
		if (!database) {
			if (migrations.length > 0)
				throw new PluginError("migrations need a configured database");
			return;
		}
		const pool = openPool(database.url);
		try {
			const report = await runMigrations(pool, this.#active);
			this.#options.logger.info(
				{
					applied: report.applied,
					skipped: report.skipped.length,
					everyBoot: report.everyBoot.length,
				},
				"migrations",
			);
		} catch (error) {
			await pool.close();
			if (error instanceof MigrationError) {
				const owner = this.#active.find((plugin) =>
					plugin.migrations?.some(
						({ name }) => `${plugin.name}/${name}` === error.migration,
					),
				);
				throw new PluginError(
					`plugin ${owner?.name ?? "unknown"}: migration ${error.migration} failed: ${String(error.cause)}. Fix the migration or restore the database, then start again.`,
					{ cause: error },
				);
			}
			throw error;
		}
		this.#pool = pool;
	}

	/** Shuts down once idle when the process is asked to stop, then exits with the shutdown's code. */
	listen(): void {
		const { exit = process.exit } = this.#options;
		let signalled = false;
		for (const signal of ["SIGTERM", "SIGINT"] as const)
			process.once(signal, () => {
				if (signalled) return;
				signalled = true;
				void this.shutdown(signal).then(exit);
			});
	}

	/**
	 * Stops the host once no work runs or waits and returns the exit code: 0, or 1 when the
	 * boot had failed or a listener, service or the pool did not stop. Every call shares the one
	 * shutdown.
	 */
	shutdown(signal: string): Promise<number> {
		this.#stopping ??= this.#stop(signal);
		return this.#stopping;
	}

	async #stop(signal: string): Promise<number> {
		const { logger, aborted, drain } = this.#options;
		// A signal during the boot waits for it to settle; a failed boot has already stopped.
		await this.#booting?.catch(() => undefined);
		if (running !== this) return this.#bootFailed ? 1 : 0;
		// Everything keeps serving until nothing runs or waits, so a deploy never cuts a turn short.
		logger.info({ signal }, "shutting down once idle");
		const left = await waitUntilIdle({
			...drain,
			busy: () => [
				...this.#queue.busy(),
				...this.#started.flatMap((service) => service.busy?.() ?? []),
			],
		});
		if (left.length > 0) {
			logger.warn(
				{ aborted: left },
				"still busy after the drain limit; aborting",
			);
			const recorded = await attempt(() => aborted?.(left));
			if (!recorded.ok)
				logger.error({ err: recorded.error }, "aborted work not recorded");
		}
		await this.#events.deliver("shutdown", left);
		logger.info({ signal }, "shutting down");
		const clean = await this.#teardown();
		running = undefined;
		return clean ? 0 : 1;
	}

	/**
	 * Stops what a start or a run left going, in reverse of how it started: the listeners, then
	 * the started services, then the pool. Each failure is logged and the rest still stop;
	 * returns whether all of them did.
	 */
	async #teardown(): Promise<boolean> {
		const { logger } = this.#options;
		let clean = true;
		// No request may reach a service that has stopped.
		const closed = await attempt(() => this.#listeners?.stop());
		if (!closed.ok) {
			clean = false;
			logger.error({ err: closed.error }, "http listeners did not close");
		}
		for (const service of this.#started.toReversed()) {
			const stopped = await attempt(() => service.stop?.());
			if (!stopped.ok) {
				clean = false;
				logger.error(
					{ service: service.name, err: stopped.error },
					"service did not stop",
				);
			}
		}
		// Last, once nothing that queries it runs.
		const released = await attempt(() => this.#pool?.close());
		if (!released.ok) {
			clean = false;
			logger.error({ err: released.error }, "database pool did not close");
		}
		this.#listeners = undefined;
		this.#started = [];
		this.#pool = undefined;
		return clean;
	}
}
