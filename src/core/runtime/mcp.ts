import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { mcpAdapterExtension } from "../shared/mcp-adapter.ts";

/** An MCP server a session connects to, with the tools it offers. */
export interface VirtualServer {
	name: string;
	url: string;
	tools: string[];
}

/** The owner's MCP gateway virtual servers, reached with the process's admin token. */
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
