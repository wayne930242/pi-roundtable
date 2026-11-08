import type { SQL } from "bun";
import type { Logger, Migration } from "pi-roundtable";
import type { VirtualServer } from "pi-roundtable/kit";
import {
	type Connector,
	ConnectorError,
	type ConnectorProfileSource,
	ConnectorRateLimited,
	type NewConnector,
	type Resynced,
	type ResyncOutcome,
} from "./connector-results.ts";
import {
	isLockout,
	provisionalServer,
	ResyncGate,
	sameServer,
	usableTools,
} from "./connector-resync.ts";
import {
	type ContextForgeAdmin,
	ContextForgeError,
	type GatewayTool,
} from "./contextforge.ts";
import { CONNECTOR_MESSAGES, type ConnectorMessages } from "./messages.ts";

export {
	type Connector,
	ConnectorError,
	type ConnectorProfileSource,
	ConnectorRateLimited,
	type NewConnector,
	type Resynced,
	type ResyncOutcome,
};

/** Lowercase, short enough that `<name>-<tool>` usually fits the tool name limit. */
export const CONNECTOR_NAME = /^[a-z][a-z0-9-]{0,11}$/;
/** The longest tool name kept: Claude allows 64 characters, and a client may add a 19-character prefix. */
export const DEFAULT_MAX_TOOL_NAME = 45;
/** What a virtual server's name starts with, so ContextForge's own servers are never taken for a connector's. */
export const DEFAULT_SERVER_PREFIX = "roundtable-conn-";

interface Row {
	name: string;
	url: string;
	description: string;
	gateway_id: string;
	server_id: string;
	created_at: Date;
}

export interface ConnectorRegistryOptions {
	admin: Pick<
		ContextForgeAdmin,
		| "createGateway"
		| "tools"
		| "createServer"
		| "refreshGateway"
		| "setServerTools"
		| "deleteServer"
		| "deleteGateway"
	>;
	/** Reads a virtual server's endpoint and tools by name. */
	resolve: (serverName: string) => Promise<VirtualServer>;
	logger: Logger;
	/** The start of every connector's virtual server name; default `roundtable-conn-`. */
	serverPrefix?: string;
	/** Tools whose names are longer are left out of a connector's server; default 45. */
	maxToolName?: number;
	/**
	 * The least time between two admin requests of resyncs, whichever connector they are for; default
	 * 1200 (50 a minute). A resync of a connector makes five. 0 turns pacing off.
	 */
	resyncIntervalMs?: number;
	/**
	 * How long resyncs are refused, without a request, after the gateway answered 429, 401, 403 or 423;
	 * default 15 minutes, the time its lock on the admin account lasts.
	 */
	resyncLockoutMs?: number;
	messages?: ConnectorMessages;
}

/**
 * The owner's MCP connectors. ContextForge holds each upstream server and its token; the
 * `owner_connectors` table holds what the app needs to route to it. `version` changes with
 * every add, change, or removal, so a host knows to pick up the new tool set.
 */
export class ConnectorRegistry {
	readonly #sql: SQL;
	readonly #options: ConnectorRegistryOptions;
	readonly #text: ConnectorMessages;
	readonly #connectors = new Map<string, Connector>();
	#version = 0;
	/** The resync in progress or last done; the next one waits for it, so ContextForge sees one request at a time. */
	#resyncing: Promise<unknown> = Promise.resolve();
	readonly #gate: ResyncGate;

	private constructor(sql: SQL, options: ConnectorRegistryOptions) {
		this.#sql = sql;
		this.#options = options;
		this.#text = options.messages ?? CONNECTOR_MESSAGES;
		this.#gate = new ResyncGate(
			options.resyncIntervalMs,
			options.resyncLockoutMs,
		);
	}

	/** The registry's table; the host runs this before the registry attaches. */
	static readonly migration: Migration = {
		name: "owner-connectors",
		up: async (sql) => {
			await sql`
				CREATE TABLE IF NOT EXISTS owner_connectors (
					name text PRIMARY KEY,
					url text NOT NULL,
					description text NOT NULL,
					gateway_id text NOT NULL,
					server_id text NOT NULL,
					created_at timestamptz NOT NULL DEFAULT now()
				)`;
		},
	};

	/** The registry over the host's migrated pool, with no connector read yet; `load()` reads them. */
	static attach(
		sql: SQL,
		options: ConnectorRegistryOptions,
	): ConnectorRegistry {
		return new ConnectorRegistry(sql, options);
	}

	/** Reads the stored connectors and resolves each one's server; one that cannot be reached is logged and left without a server. Changes `version`. */
	async load(): Promise<void> {
		const rows: Row[] = await this
			.#sql`SELECT * FROM owner_connectors ORDER BY name`;
		for (const row of rows) {
			const connector = fromRow(row);
			// One unreachable connector must not keep the host from starting.
			try {
				connector.server = await this.#options.resolve(
					this.serverName(row.name),
				);
			} catch (error) {
				this.#options.logger.error(
					{ connector: row.name, err: error },
					"connector could not be read; its profile is off",
				);
			}
			this.#connectors.set(row.name, connector);
		}
		// What a host built from the list before this is stale.
		this.#version += 1;
	}

	/** The name of the connector's virtual server in ContextForge. */
	serverName(name: string): string {
		return `${this.#options.serverPrefix ?? DEFAULT_SERVER_PREFIX}${name}`;
	}

	get version(): number {
		return this.#version;
	}

	list(): Connector[] {
		return [...this.#connectors.values()];
	}

	/** Virtual servers of the connectors whose tools are known. */
	servers(): VirtualServer[] {
		return this.list().flatMap((c) => (c.server ? [c.server] : []));
	}

	profileSources(): ConnectorProfileSource[] {
		return this.list().flatMap((c) =>
			c.server
				? [
						{
							name: c.name,
							description: c.description,
							serverName: c.server.name,
						},
					]
				: [],
		);
	}

	/**
	 * Registers the server in ContextForge, exposes its usable tools on a virtual server, and
	 * records the connector. Anything half made is removed again when a later step fails.
	 */
	async add(
		input: NewConnector,
	): Promise<{ connector: Connector; skipped: string[] }> {
		const name = await this.#checked(input);
		const { admin } = this.#options;
		const gateway = await this.#contextForge(() =>
			admin.createGateway({
				name,
				url: input.url,
				description: input.description,
				auth: input.auth,
			}),
		);
		const made: { serverId?: string } = {};
		try {
			return await this.#publish(name, input, gateway, made);
		} catch (error) {
			await this.#removeFromContextForge(name, gateway.id, made.serverId);
			throw error;
		}
	}

	async describe(name: string, description: string): Promise<Connector> {
		const connector = this.#get(name);
		const text = description.trim();
		if (!text) throw new ConnectorError(this.#text.purposeEmpty);
		await this
			.#sql`UPDATE owner_connectors SET description = ${text} WHERE name = ${name}`;
		connector.description = text;
		this.#version += 1;
		return connector;
	}

	/** Deletes the connector, its virtual server, and the upstream server with its token. */
	async remove(name: string): Promise<void> {
		const connector = this.#get(name);
		await this.#sql`DELETE FROM owner_connectors WHERE name = ${name}`;
		this.#connectors.delete(name);
		this.#version += 1;
		await this.#removeFromContextForge(
			name,
			connector.gatewayId,
			connector.serverId,
		);
		this.#options.logger.info({ connector: name }, "connector removed");
	}

	/** The normalized name, once the input and the name are known to be acceptable. */
	async #checked(input: NewConnector): Promise<string> {
		const name = input.name.trim().toLowerCase();
		if (!CONNECTOR_NAME.test(name))
			throw new ConnectorError(this.#text.nameRule);
		if (!/^https?:\/\//.test(input.url) || !URL.canParse(input.url))
			throw new ConnectorError(this.#text.urlRule);
		if (!input.description.trim())
			throw new ConnectorError(this.#text.purposeRequired);
		const taken = new Set([
			...this.#connectors.keys(),
			...(await this.#options.admin.tools()).map((tool) => tool.gatewaySlug),
		]);
		if (taken.has(name)) throw new ConnectorError(this.#text.nameTaken(name));
		return name;
	}

	/** Builds the virtual server over the gateway's usable tools and records the connector. */
	async #publish(
		name: string,
		input: NewConnector,
		gateway: { id: string; slug: string },
		made: { serverId?: string },
	): Promise<{ connector: Connector; skipped: string[] }> {
		const { admin, resolve, logger } = this.#options;
		const { usable, skipped } = this.#usable(
			(await admin.tools()).filter((tool) => tool.gatewaySlug === gateway.slug),
		);
		const serverId = await this.#contextForge(() =>
			admin.createServer(
				this.serverName(name),
				this.#text.serverDescription(name, input.description),
				usable.map((tool) => tool.id),
			),
		);
		made.serverId = serverId;
		const server = await resolve(this.serverName(name));
		const rows: Row[] = await this.#sql`
			INSERT INTO owner_connectors (name, url, description, gateway_id, server_id)
			VALUES (${name}, ${input.url}, ${input.description.trim()}, ${gateway.id}, ${serverId})
			RETURNING *`;
		const row = rows[0];
		if (!row) throw new Error("connector row was not written");
		const connector = { ...fromRow(row), server };
		this.#connectors.set(name, connector);
		this.#version += 1;
		logger.info(
			{ connector: name, tools: server.tools.length, skipped },
			"connector added",
		);
		return { connector, skipped };
	}

	/** A gateway's usable tools and the names left out, under this registry's limit and wording. */
	#usable(tools: GatewayTool[]) {
		return usableTools(
			tools,
			this.#options.maxToolName ?? DEFAULT_MAX_TOOL_NAME,
			this.#text,
		);
	}

	/**
	 * Has ContextForge read the connector's upstream server again and makes its virtual server serve
	 * the gateway's tools as they are now, with their hints. A renamed tool is attached, a removed one
	 * detached; the gateway, the virtual server, the token, the purpose, and the stored row stay.
	 * A failure before the refresh leaves the connector as it was. The refresh removes the tools the
	 * upstream no longer offers from the virtual server, so a failure after it may leave the server with
	 * fewer tools until the next resync; the cache lists the old and the new names meanwhile, so a hold
	 * rule still finds every name the gateway may serve.
	 */
	async resync(name: string): Promise<Resynced> {
		this.#get(name);
		return this.#inTurn(() => this.#resync(name));
	}

	/**
	 * Resyncs every connector, one after the other, at the pace `resyncIntervalMs` sets; a failure is
	 * logged and reported, and none is removed. When the gateway answers 429, 401, 403 or 423 the rest
	 * are reported as not resynced, and nothing is asked for `resyncLockoutMs`.
	 */
	async resyncAll(): Promise<ResyncOutcome[]> {
		return this.#inTurn(async () => {
			const outcomes: ResyncOutcome[] = [];
			const names = this.list().map((c) => c.name);
			for (const [index, name] of names.entries()) {
				try {
					outcomes.push({ name, ...(await this.#resync(name)) });
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					outcomes.push({ name, error: message });
					if (error instanceof ConnectorRateLimited) {
						const rest = names.slice(index + 1);
						this.#options.logger.error(
							{ connector: name, notResynced: rest, err: error },
							"ContextForge refused the admin account; the remaining connectors are not resynced and keep their servers",
						);
						for (const left of rest)
							outcomes.push({
								name: left,
								error: this.#text.resyncNotAttempted,
							});
						break;
					}
					this.#options.logger.error(
						{ connector: name, err: error },
						"connector could not be resynced",
					);
				}
			}
			return outcomes;
		});
	}

	/** Runs `work` once the resync before it is over, whether that one succeeded or not. */
	#inTurn<T>(work: () => Promise<T>): Promise<T> {
		const turn = this.#resyncing.then(work);
		this.#resyncing = turn.catch(() => undefined);
		return turn;
	}

	async #resync(name: string): Promise<Resynced> {
		const connector = this.#get(name); // it may have been removed while this waited
		if (this.#gate.locked)
			throw new ConnectorRateLimited(this.#text.resyncNotAttempted);
		try {
			return await this.#sync(connector);
		} catch (error) {
			if (error instanceof ConnectorRateLimited) this.#gate.lock();
			throw error;
		}
	}

	async #sync(connector: Connector): Promise<Resynced> {
		const { admin, resolve, logger } = this.#options;
		const { name } = connector;
		await this.#gate.pace(1);
		await this.#contextForge(() =>
			admin.refreshGateway(connector.gatewayId, connector.url),
		);
		// From here a failure may leave the virtual server with fewer tools: the refresh dropped some.
		try {
			await this.#gate.pace(1);
			const { usable, skipped } = this.#usable(
				(await this.#contextForge(() => admin.tools())).filter(
					(tool) => tool.gatewayId === connector.gatewayId,
				),
			);
			const before = connector.server;
			// The new names are served once the update lands, even if reading them back fails.
			if (before) this.#show(connector, provisionalServer(before, usable));
			await this.#gate.pace(1);
			await this.#contextForge(() =>
				admin.setServerTools(
					connector.serverId,
					usable.map((tool) => tool.id),
				),
			);
			// Reading a virtual server takes two requests: the list, then its tools.
			await this.#gate.pace(2);
			const server = await resolve(this.serverName(name)).catch(
				(error: unknown) => {
					const message =
						error instanceof Error ? error.message : String(error);
					throw isLockout(error)
						? new ConnectorRateLimited(message)
						: new ConnectorError(message);
				},
			);
			const had = before?.tools ?? [];
			const added = server.tools.filter((tool) => !had.includes(tool));
			const removed = had.filter((tool) => !server.tools.includes(tool));
			this.#show(connector, server);
			logger.info(
				{
					connector: name,
					tools: server.tools.length,
					added,
					removed,
					skipped,
				},
				"connector resynced",
			);
			return { connector, skipped, added, removed };
		} catch (error) {
			logger.error(
				{ connector: name, err: error },
				"connector resync failed after ContextForge read its upstream; the virtual server may serve fewer tools until the next resync",
			);
			throw error;
		}
	}

	/** The connector's cache from now on; `version` changes when it differs. */
	#show(connector: Connector, server: VirtualServer): void {
		if (this.#connectors.get(connector.name) !== connector) return;
		const before = connector.server;
		connector.server = server;
		if (!before || !sameServer(before, server)) this.#version += 1;
	}

	#get(name: string): Connector {
		const connector = this.#connectors.get(name);
		if (!connector) throw new ConnectorError(this.#text.unknownConnector(name));
		return connector;
	}

	/** ContextForge's refusals become messages the owner can act on. */
	async #contextForge<T>(call: () => Promise<T>): Promise<T> {
		try {
			return await call();
		} catch (error) {
			if (error instanceof ContextForgeError)
				throw isLockout(error)
					? new ConnectorRateLimited(error.message)
					: new ConnectorError(error.message);
			throw error;
		}
	}

	/** Best effort: a leftover is logged, since ContextForge's admin UI can still remove it. */
	async #removeFromContextForge(
		name: string,
		gatewayId: string,
		serverId: string | undefined,
	): Promise<void> {
		const { admin, logger } = this.#options;
		const steps: [string, () => Promise<void>][] = [
			...(serverId
				? [
						["server", () => admin.deleteServer(serverId)] as [
							string,
							() => Promise<void>,
						],
					]
				: []),
			["gateway", () => admin.deleteGateway(gatewayId)],
		];
		for (const [what, step] of steps) {
			try {
				await step();
			} catch (error) {
				logger.error(
					{ connector: name, what, err: error },
					"connector leftover in ContextForge",
				);
			}
		}
	}
}

function fromRow(row: Row): Connector {
	return {
		name: row.name,
		url: row.url,
		description: row.description,
		gatewayId: row.gateway_id,
		serverId: row.server_id,
		createdAt: row.created_at,
	};
}
