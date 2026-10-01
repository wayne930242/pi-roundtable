import type { SQL } from "bun";
import type { Logger, Migration } from "pi-roundtable";
import type { VirtualServer } from "pi-roundtable/kit";
import {
	type ContextForgeAdmin,
	ContextForgeError,
	type UpstreamAuth,
} from "./contextforge.ts";
import { CONNECTOR_MESSAGES, type ConnectorMessages } from "./messages.ts";

/** Lowercase, short enough that `<name>-<tool>` usually fits the tool name limit. */
export const CONNECTOR_NAME = /^[a-z][a-z0-9-]{0,11}$/;
/** The longest tool name kept: Claude allows 64 characters, and a client may add a 19-character prefix. */
export const DEFAULT_MAX_TOOL_NAME = 45;
/** What a virtual server's name starts with, so ContextForge's own servers are never taken for a connector's. */
export const DEFAULT_SERVER_PREFIX = "roundtable-conn-";

/** A request the owner can fix; the message is shown to the owner as is. */
export class ConnectorError extends Error {}

export interface Connector {
	name: string;
	url: string;
	description: string;
	gatewayId: string;
	serverId: string;
	createdAt: Date;
	/** The virtual server's endpoint and tools; absent when it could not be read. */
	server?: VirtualServer;
}

export interface NewConnector {
	name: string;
	url: string;
	description: string;
	auth: UpstreamAuth;
}

/** An owner connector as a routing profile source: the general tools plus every tool of its virtual server. */
export interface ConnectorProfileSource {
	name: string;
	description: string;
	/** The connector's virtual server, which a profile lists among its MCP servers. */
	serverName: string;
}

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

	private constructor(sql: SQL, options: ConnectorRegistryOptions) {
		this.#sql = sql;
		this.#options = options;
		this.#text = options.messages ?? CONNECTOR_MESSAGES;
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

	/** The registry over the host's migrated pool, with each connector's server resolved. */
	static async attach(
		sql: SQL,
		options: ConnectorRegistryOptions,
	): Promise<ConnectorRegistry> {
		const registry = new ConnectorRegistry(sql, options);
		const rows: Row[] = await sql`SELECT * FROM owner_connectors ORDER BY name`;
		for (const row of rows) {
			const connector = fromRow(row);
			// One unreachable connector must not keep the host from starting.
			try {
				connector.server = await options.resolve(registry.serverName(row.name));
			} catch (error) {
				options.logger.error(
					{ connector: row.name, err: error },
					"connector could not be read; its profile is off",
				);
			}
			registry.#connectors.set(row.name, connector);
		}
		return registry;
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
		const {
			admin,
			resolve,
			logger,
			maxToolName = DEFAULT_MAX_TOOL_NAME,
		} = this.#options;
		const tools = (await admin.tools()).filter(
			(tool) => tool.gatewaySlug === gateway.slug,
		);
		const usable = tools.filter((tool) => tool.name.length <= maxToolName);
		const skipped = tools
			.filter((tool) => tool.name.length > maxToolName)
			.map((tool) => tool.name);
		if (usable.length === 0)
			throw new ConnectorError(
				tools.length === 0
					? this.#text.noTools
					: this.#text.toolsTooLong(maxToolName, skipped),
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
				throw new ConnectorError(error.message);
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
