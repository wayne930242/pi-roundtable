import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { mcpAdapterExtension } from "../shared/mcp-adapter.ts";

/** An MCP server a session connects to, with the tools it offers. */
export interface VirtualServer {
	name: string;
	url: string;
	tools: string[];
}

/** MCP endpoints supplied by a session plugin, reached with its bearer token. */
export function mcpExtension(
	servers: readonly VirtualServer[],
	token: string,
): ExtensionFactory {
	return mcpAdapterExtension(
		servers.map((server) => ({
			name: server.name,
			url: server.url,
			bearerToken: token,
		})),
	);
}
