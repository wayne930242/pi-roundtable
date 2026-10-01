import {
	ConfigError,
	definePlugin,
	type RoundtablePlugin,
	serviceKey,
} from "pi-roundtable";
import { DISCORD } from "pi-roundtable/discord";
import type { VirtualServer } from "pi-roundtable/kit";
import { connectorCommands } from "./connector-commands.ts";
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
	return definePlugin({
		name: "mcp-connectors",
		requires: [DISCORD],
		provides: [CONNECTORS],
		migrations: [ConnectorRegistry.migration],
		setup: async ({ database, services, logger }) => {
			const { jwtSecret, user } = options.contextForge;
			const token = contextForgeToken(jwtSecret, user, TOKEN_TTL_SECONDS);
			const registry = await ConnectorRegistry.attach(database(), {
				admin: new ContextForgeAdmin(url, token),
				resolve: (name) => resolveVirtualServer(url, token, name),
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
			});
			return {};
		},
	});
}
