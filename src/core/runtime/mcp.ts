import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { mcpAdapterExtension } from "../shared/mcp-adapter.ts";

/** A tool's MCP safety hints as its server declares them; a hint it leaves out is absent. */
export interface McpToolHints {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

/** An MCP server a session connects to, with the tools it offers. */
export interface VirtualServer {
	name: string;
	url: string;
	tools: string[];
	/** Each tool's hints by tool name; a tool without an entry declared none. Absent when its source reads no hints. */
	hints?: Readonly<Record<string, McpToolHints>>;
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
