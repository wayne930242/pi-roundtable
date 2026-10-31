import {
	ConfigError,
	definePlugin,
	type RoundtablePlugin,
	serviceKey,
} from "pi-roundtable";
import { DISCORD } from "pi-roundtable/discord";
import type { VirtualServer } from "pi-roundtable/kit";
import { connectorCommands } from "./connector-commands.ts";
import { authFrom } from "./connector-input.ts";
import {
	type Connector,
	type ConnectorProfileSource,
	ConnectorRegistry,
	DEFAULT_MAX_TOOL_NAME,
	DEFAULT_SERVER_PREFIX,
} from "./connector-registry.ts";
import {
	ContextForgeAdmin,
	contextForgeToken,
	resolveVirtualServer,
} from "./contextforge.ts";
import { type ConnectorMessages, connectorMessages } from "./messages.ts";

/** One token per process, valid for a year; every restart mints a fresh one. */
const TOKEN_TTL_SECONDS = 365 * 24 * 3600;

export interface ContextForgeOptions {
	/** The gateway's base URL, such as `http://localhost:4444`. */
	url: string;
	/** The secret ContextForge signs and verifies its JWTs with. */
	jwtSecret: string;
	/** The admin user the plugin acts as, an email address such as `admin@example.com`. */
	user: string;
}

export interface McpConnectorsOptions {
	contextForge: ContextForgeOptions;
	/** The start of every connector's virtual server name in ContextForge; default `roundtable-conn-`. */
	serverPrefix?: string;
	/** Tools whose names are longer are left out of a connector's server; default 45. */
	maxToolName?: number;
	/** The Discord text and the registry's refusals, in your wording; English by default. */
	messages?: Partial<ConnectorMessages>;
}

/** What a host reads to give its agents the owner's connectors. */
export interface Connectors {
	/** Changes on every add, description change, and removal, so a host knows its tool sets are stale. */
	readonly version: number;
	list(): Connector[];
	/** Virtual servers of the connectors whose tools are known. */
	servers(): VirtualServer[];
	/** Each connector as the profile source a host builds a per-agent MCP profile from. */
	profileSources(): ConnectorProfileSource[];
	/** The bearer token that ContextForge's virtual server URLs expect; one per process. */
	readonly token: string;
	/** Reads a virtual server's endpoint and tools by name, for the servers a host manages itself. */
	resolve(serverName: string): Promise<VirtualServer>;
	/** What ContextForge holds, upstream gateways and virtual servers, for a host's status view. */
	readonly admin: Pick<ContextForgeAdmin, "gateways" | "servers">;
	/**
	 * Adds a connector as `/<root> connector add` does. No token is no authentication, a token alone
	 * is sent as `Authorization: Bearer`, and a header name sends the token in that header. The
	 * token goes to ContextForge only; nothing returned holds it. A refusal is a `ConnectorError`.
	 */
	add(
		input: ConnectorInput,
	): Promise<{ connector: Connector; skipped: string[] }>;
	/** Changes a connector's purpose; a refusal is a `ConnectorError`. */
	describe(name: string, description: string): Promise<Connector>;
	/** Deletes a connector, its virtual server, and its upstream server with its token. */
	remove(name: string): Promise<void>;
}

/** A new connector as the owner gives it; `header` and `token` are optional. */
export interface ConnectorInput {
	name: string;
	url: string;
	description: string;
	header?: string;
	token?: string;
}

/** The registry's management, with the header and token rules of the Discord form. */
export function connectorManagement(
	registry: Pick<ConnectorRegistry, "add" | "describe" | "remove">,
	text: ConnectorMessages,
): Pick<Connectors, "add" | "describe" | "remove"> {
	return {
		add: async (input) =>
			registry.add({
				name: input.name.trim(),
				url: input.url.trim(),
				description: input.description.trim(),
				auth: authFrom(
					input.header?.trim() ?? "",
					input.token?.trim() ?? "",
					text,
				),
			}),
		describe: (name, description) => registry.describe(name, description),
		remove: (name) => registry.remove(name),
	};
}

export const CONNECTORS = serviceKey<Connectors>(
	"pi-roundtable-mcp.connectors",
);

function checkOptions({ contextForge }: McpConnectorsOptions): string {
	const base = URL.parse(contextForge.url);
	if (base?.protocol !== "http:" && base?.protocol !== "https:")
		throw new ConfigError(
			"mcp-connectors: contextForge.url must be an http(s) URL",
		);
	if (!contextForge.jwtSecret)
		throw new ConfigError("mcp-connectors: contextForge.jwtSecret is empty");
	if (!contextForge.user)
		throw new ConfigError("mcp-connectors: contextForge.user is empty");
	return contextForge.url.replace(/\/+$/, "");
}

/**
 * The owner's MCP connectors: ContextForge holds each upstream server and its token, a table
 * holds what the host needs to route to it, and `/<root> connector` adds and removes them.
 * Provides `CONNECTORS`.
 */
export function mcpConnectors(options: McpConnectorsOptions): RoundtablePlugin {
	const url = checkOptions(options);
	const text = connectorMessages(options.messages);
	let load: (() => Promise<void>) | undefined;
	return definePlugin({
		name: "mcp-connectors",
		requires: [DISCORD],
		provides: [CONNECTORS],
		migrations: [ConnectorRegistry.migration],
		// The stored connectors are read, and their servers resolved, before any service starts, so
		// Discord takes no command or turn that sees an empty list; `Roundtable.check()` never runs it.
		preflight: () => load?.(),
		setup: ({ database, services, logger }) => {
			const { jwtSecret, user } = options.contextForge;
			const token = contextForgeToken(jwtSecret, user, TOKEN_TTL_SECONDS);
			const admin = new ContextForgeAdmin(url, token, fetch, text);
			const resolve = (name: string) =>
				resolveVirtualServer(url, token, name, fetch, text);
			const registry = ConnectorRegistry.attach(database(), {
				admin,
				resolve,
				logger,
				serverPrefix: options.serverPrefix ?? DEFAULT_SERVER_PREFIX,
				maxToolName: options.maxToolName ?? DEFAULT_MAX_TOOL_NAME,
				messages: text,
			});
			const { commands, guard } = services.get(DISCORD);
			commands.add(connectorCommands(guard, registry, text));
			services.provide(CONNECTORS, {
				get version() {
					return registry.version;
				},
				list: () => registry.list(),
				servers: () => registry.servers(),
				profileSources: () => registry.profileSources(),
				token,
				resolve,
				admin: {
					gateways: () => admin.gateways(),
					servers: () => admin.servers(),
				},
				...connectorManagement(registry, text),
			});
			// Nothing is added but what preflight reads.
			load = () => registry.load();
			return {};
		},
	});
}
