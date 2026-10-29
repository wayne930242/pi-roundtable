import type { SQL } from "bun";
import type { Hex } from "../characters/index.ts";
import type { AttachmentRetention } from "./attachments/attachment-retention.ts";
import { checkDatabase } from "./db/check-database.ts";
import { openPool, runMigrations } from "./db/migrations.ts";
import { type DrainOptions, drainWork, stopTurns } from "./drain.ts";
import { MigrationError, PluginError } from "./errors.ts";
import { attempt, startInBackground } from "./host-background.ts";
import { Linkage, type RegistrationReport } from "./host-registration.ts";
import type { HttpListeners, ListenerConfig } from "./http/listeners.ts";
import type { Locale } from "./i18n/index.ts";
import type { JudgeModel } from "./judging/model-judge.ts";
import type { Logger } from "./log.ts";
import type { AgentTools, RoundtablePlugin, Service } from "./plugin.ts";
import { RUNTIME } from "./services.ts";
import type { ChannelKey } from "./sessions.ts";
import type { ToolTierTable } from "./tool-tiers.ts";

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
	/** The host's scratch dir, which plugins read as `env.scratchDir`; unset gives them none. */
	scratchDir?: string;
	/** Six `#rrggbb` skin tones for the agents' characters, which plugins read as `env.characterSkins`; default the package's own. Anything but six valid colors stops the start. */
	characterSkins?: readonly Hex[];
	/** What the agents' turns may use of the machine, which plugins read as `env.agentTools`; default "full". */
	agentTools?: AgentTools;
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
	/** The directory the host keeps files in; `context.attachments` keeps its files there. Without it that port refuses every call. */
	dataDir?: string;
	/**
	 * What the host does with the attachments it keeps. `retention` removes the files turns used once
	 * they are `maxAgeMs` old, sweeping at start and every `sweepEveryMs` (default one hour), and gives
	 * the owners' used-bytes allowance back; without it used files live as long as their conversation.
	 * Needs `dataDir`.
	 */
	attachments?: { retention?: AttachmentRetention };
	/** Receives the work a shutdown drain gave up on, before any service stops. */
	aborted?: (left: string[]) => Promise<void>;
	/**
	 * The shutdown drain: it waits up to `limitMs` (3 minutes by default) for the turns already
	 * running, then stops them, gives them `abortGraceMs` (10 seconds) to end, and goes on without
	 * them. Nothing new starts once it begins. Tests shorten the limits and the clock.
	 */
	drain?: Omit<DrainOptions, "busy">;
	/** What `listen()` calls with the shutdown's exit code; the process's own exit by default. */
	exit?: (code: number) => void;
}

/** The host running in this process; the text catalog, time zone and environment are process-wide. */
let running: Roundtable | undefined;

/**
 * The process around the plugins: it sets them all up, links what they add (session parts,
 * HTTP routes) and runs the preflight, then starts their services in order and the
 * HTTP listeners last, then runs the services' background starts. Nothing reaches Discord or a listener unless
 * every setup, link, and the preflight succeeded. On shutdown it starts no new work, waits for
 * what runs for at most the drain limit, then closes the listeners and stops the services in
 * reverse.
 */
// pi-lens-ignore: large-class
export class Roundtable {
	readonly #options: RoundtableOptions;
	readonly #plugins: readonly RoundtablePlugin[];
	/** What the plugins' registration built: the registry, router, queue and events the host runs on. */
	readonly #link: Linkage;
	#listeners: HttpListeners | undefined;
	#pool: SQL | undefined;
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
		this.#link = new Linkage(options, plugins);
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

	async #boot(): Promise<void> {
		const link = this.#link;
		link.prepare();
		await this.#migrate();
		const { http, retention } = await link.link(() => {
			if (!this.#pool) throw new PluginError("no database is configured");
			return this.#pool;
		});
		for (const plugin of link.active) await plugin.preflight?.();
		// Last, so the probe sees the tools other plugins fill in during their preflight.
		await link.services?.find(RUNTIME)?.preflight?.();
		for (const service of [...link.registry.services, ...retention]) {
			await service.start?.();
			this.#started.push(service);
		}
		// Requests arrive only once everything they may reach is running.
		this.#listeners = http;
		http.start();
		// After the listeners, so a background start may rely on everything else running.
		void startInBackground(link.registry, this.#options.logger);
	}

	/**
	 * Sets up every plugin as `run()` would and refuses what `run()` refuses (a plugin that adds
	 * nothing, a clash, a missing service, a removed field, a bad route), without migrating the
	 * database, starting a service, opening a listener or reaching Discord. A plugin that queries the
	 * database during setup is refused with a message that says to query from a service's start.
	 * Preflights are not run. It runs each plugin's `setup`, so check a definition you do not run,
	 * such as `defineRoundtable` called again: the built-in agent server binds its sessions once, and
	 * a plugin keeps whatever its setup keeps. As `run()` does, it sets the process's locale and time
	 * zone, and `PI_CODING_AGENT_DIR` when `environment.agentDir` is set. It does not count as a
	 * running host.
	 */
	async check(): Promise<RegistrationReport> {
		const link = new Linkage(this.#options, this.#plugins);
		link.prepare();
		await link.link(checkDatabase);
		return link.report();
	}

	/** Opens the pool and runs every plugin's migrations; a failure closes it again and stops the boot. */
	async #migrate(): Promise<void> {
		const migrations = this.#link.active.flatMap(
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
			const report = await runMigrations(pool, this.#link.active);
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
				const owner = this.#link.active.find((plugin) =>
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
	 * Stops the host once no work runs or waits, or the drain limit has passed, and returns the
	 * exit code: 0, or 1 when the
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
		// Turns already running finish, but nothing new starts from here on, whoever asks.
		logger.info({ signal }, "shutting down once idle");
		this.#link.queue.close();
		const left = await drainWork({
			...drain,
			busy: () => [
				...this.#link.queue.busy(),
				...this.#started.flatMap((service) => service.busy?.() ?? []),
			],
			// A turn the limit finds still running is stopped, as the owner's stop would.
			abort: () =>
				stopTurns(
					this.#link.queue.busy(),
					(channel) => this.#link.router?.stop(channel as ChannelKey) ?? false,
					logger,
				),
		});
		if (left.length > 0) {
			logger.warn(
				{ aborted: left },
				"still busy after the drain limit; aborted",
			);
			const recorded = await attempt(() => aborted?.(left));
			if (!recorded.ok)
				logger.error({ err: recorded.error }, "aborted work not recorded");
		}
		await this.#link.events.deliver("shutdown", left);
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
