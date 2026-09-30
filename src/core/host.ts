import type { SQL } from "bun";
import type { ConversationPort } from "./contract/channels.ts";
import type { CommandRoot } from "./contract/discord.ts";
import { migrate, openPool } from "./db/migrations.ts";
import { type DrainOptions, waitUntilIdle } from "./drain.ts";
import { MigrationError, NotLinkedError, PluginError } from "./errors.ts";
import { EventBus } from "./events.ts";
import { HttpListeners, type ListenerConfig } from "./http/listeners.ts";
import type { JudgeModel } from "./judging/model-judge.ts";
import type { Logger } from "./log.ts";
import type {
	AgentServerOutcome,
	LinkedSessions,
	RoundtablePlugin,
} from "./plugin.ts";
import {
	collectContributions,
	emptyRegistry,
	linkSessions,
	type Registry,
} from "./registry/contributions.ts";
import { composeInteractions } from "./registry/interactions.ts";
import { resolveProviders } from "./registry/providers.ts";
import { ChannelQueue } from "./routing/channel-queue.ts";
import { ChannelRouter } from "./routing/channel-router.ts";
import { CoreRegistry } from "./services.ts";
import { type ToolTierTable, toolTiers } from "./tool-tiers.ts";

export interface RoundtableOptions {
	logger: Logger;
	/**
	 * The root command the plugins' subcommands go under; the composed commands go to the plugins'
	 * `useCommands` before any service starts, since Discord registers them as it connects.
	 */
	commands?: {
		root: CommandRoot;
	};
	/** The HTTP listeners plugins attach routes to. */
	listeners?: readonly ListenerConfig[];
	/** How long a bare forward waits for the message it follows. */
	conversations?: {
		forwardJoinMs?: number;
	};
	/** The model the default judge asks, when no plugin provides a judge. */
	judgeModel?: JudgeModel;
	/** What each tool needs: the operator's settings, with the plugins' tools added when the host links. */
	toolTiers?: ToolTierTable;
	/** The database the plugins' migrations and stores use; the host owns its one pool. */
	database?: { url: string };
	/** Receives the work a shutdown drain gave up on, before any service stops. */
	aborted?: (left: string[]) => Promise<void>;
	/** The drain's limit and clock; tests shorten them. */
	drain?: Omit<DrainOptions, "busy">;
	exit?: (code: number) => void;
}

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

/** Starts the agent server, then tells every plugin how that went; a failing handler never stops the others. */
async function startAgentServer(
	start: () => Promise<void>,
	handlers: Registry["handlers"],
	logger: Logger,
): Promise<void> {
	const started = await attempt(start);
	// The rest of the process runs on without the agent server's new channels.
	if (started.ok) logger.info("agent server ready");
	else logger.error({ err: started.error }, "agent server did not start");
	const outcome: AgentServerOutcome = started.ok ? "ready" : "failed";
	for (const { plugin, events } of handlers) {
		const handled = await attempt(() => events.agentServer?.(outcome));
		if (!handled.ok)
			logger.error(
				{ plugin, err: handled.error },
				"agent server handler failed",
			);
	}
}

/**
 * The process around the plugins: it sets them all up, links what they add (session parts,
 * commands, HTTP routes) and runs the preflight, then starts their services in order and the
 * HTTP listeners last, and starts the agent server. Nothing reaches Discord or a listener unless
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
	readonly #core = new CoreRegistry();

	constructor(
		options: RoundtableOptions,
		plugins: readonly RoundtablePlugin[],
	) {
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
			startFresh: (channel) => router().startFresh(channel),
			deleteConversation: (channel) => router().deleteConversation(channel),
			stop: (channel) => router().stop(channel),
			postsInPlace: (channel) => router().postsInPlace(channel),
		};
	}

	/**
	 * Sets up every plugin, links what they add and runs the preflight, refusing any clash before
	 * anything starts, then starts the services and opens the listeners; the agent server starts
	 * in the background.
	 */
	async run(): Promise<void> {
		const { logger, commands, listeners = [] } = this.#options;
		const providers = resolveProviders(this.#plugins, this.#options.judgeModel);
		await this.#migrate();
		this.#registry = await collectContributions(
			this.#plugins,
			{
				logger,
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
				database: () => {
					if (!this.#pool) throw new PluginError("no database is configured");
					return this.#pool;
				},
				providers,
				core: this.#core,
				dashboard: () => {
					if (!this.#sessions)
						throw new NotLinkedError(
							"dashboard lines are linked once every plugin is set up. Call dashboard() from a service's start or from a handler, not during setup.",
						);
					return this.#registry.dashboard;
				},
			},
			this.#tiers,
		);
		const { interactions, routes, channels } = this.#registry;
		this.#sessions = linkSessions(this.#registry);
		this.#events.link(this.#registry.handlers);
		this.#router = new ChannelRouter({
			claims: channels,
			queue: this.#queue,
			stop: (channel) =>
				this.#plugins.some((plugin) => plugin.stopTurn?.(channel) ?? false),
			logger,
			...(this.#options.conversations?.forwardJoinMs === undefined
				? {}
				: { forwardJoinMs: this.#options.conversations.forwardJoinMs }),
		});
		if (interactions.length > 0 && !commands)
			throw new PluginError("interactions need a configured root command");
		const composed =
			commands && interactions.length > 0
				? composeInteractions(commands.root, interactions)
				: undefined;
		const http = new HttpListeners(listeners, routes);
		for (const plugin of this.#plugins) await plugin.preflight?.();
		if (composed)
			for (const plugin of this.#plugins) plugin.useCommands?.(composed);
		for (const service of this.#registry.services) await service.start?.();
		// Requests arrive only once everything they may reach is running.
		http.start();
		this.#listeners = http;
		const agentServer = this.#agentServer();
		if (agentServer)
			void startAgentServer(agentServer, this.#registry.handlers, logger);
	}

	/** The one plugin's way to start the agent server; two plugins that start it are refused. */
	#agentServer(): (() => Promise<void>) | undefined {
		const starting = this.#plugins.filter((plugin) => plugin.agentServer);
		const [first, second] = starting;
		if (second)
			throw new PluginError(
				`plugins ${first?.name} and ${second.name} both start the agent server. Keep one.`,
			);
		return first?.agentServer?.bind(first);
	}

	/** Opens the pool and runs every plugin's migrations; a failure closes it again and stops the boot. */
	async #migrate(): Promise<void> {
		const migrations = this.#plugins.flatMap(
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
			await migrate(pool, migrations);
		} catch (error) {
			await pool.close();
			if (error instanceof MigrationError) {
				const owner = this.#plugins.find((plugin) =>
					plugin.migrations?.some(({ name }) => name === error.migration),
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

	/** Shuts down once idle when the process is asked to stop. */
	listen(): void {
		process.once("SIGTERM", () => void this.shutdown("SIGTERM"));
		process.once("SIGINT", () => void this.shutdown("SIGINT"));
	}

	async shutdown(signal: string): Promise<void> {
		const { logger, aborted, drain, exit = process.exit } = this.#options;
		const { services } = this.#registry;
		// Everything keeps serving until nothing runs or waits, so a deploy never cuts a turn short.
		logger.info({ signal }, "shutting down once idle");
		const left = await waitUntilIdle({
			...drain,
			busy: () => services.flatMap((service) => service.busy?.() ?? []),
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
		// No request may reach a service that has stopped.
		const closed = await attempt(() => this.#listeners?.stop());
		if (!closed.ok)
			logger.error({ err: closed.error }, "http listeners did not close");
		for (const service of services.toReversed()) {
			const stopped = await attempt(() => service.stop?.());
			if (!stopped.ok)
				logger.error(
					{ service: service.name, err: stopped.error },
					"service did not stop",
				);
		}
		// Last, once nothing that queries it runs.
		const released = await attempt(() => this.#pool?.close());
		if (!released.ok)
			logger.error({ err: released.error }, "database pool did not close");
		exit(0);
	}
}
