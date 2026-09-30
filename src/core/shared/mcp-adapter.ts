import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export interface McpEndpoint {
	name: string;
	url: string;
	/** Absent when a proxy in front of the endpoint adds the credential. */
	bearerToken?: string;
}

interface McpServerEntry {
	url: string;
	auth?: "bearer";
	bearerToken?: string;
	directTools: boolean;
	lifecycle: "eager";
	toolPrefix: "none";
}

interface McpAdapterModule {
	createMcpAdapter(options: {
		config: { mcpServers: Record<string, McpServerEntry> };
	}): ExtensionFactory;
}

// pi-mcp-adapter ships TypeScript sources that fail this project's strict type check, and
// skipLibCheck does not cover .ts files. A non-literal specifier keeps tsc from following
// the import; the interface above declares the part the host uses.
const ADAPTER_MODULE: string = "pi-mcp-adapter";
const { createMcpAdapter } = (await import(ADAPTER_MODULE)) as McpAdapterModule;

/**
 * pi-mcp-adapter connected to MCP endpoints such as an MCP gateway's virtual servers. Tools
 * register directly under their server-side names (`toolPrefix: "none"`), so the names
 * the host activates are the names the gateway lists, and they stay within Claude's
 * 64-character limit after claude-bridge adds its own prefix.
 */
export function mcpAdapterExtension(
	endpoints: readonly McpEndpoint[],
): ExtensionFactory {
	return createMcpAdapter({
		config: {
			mcpServers: Object.fromEntries(
				endpoints.map((endpoint) => [
					endpoint.name,
					{
						url: endpoint.url,
						...(endpoint.bearerToken
							? { auth: "bearer" as const, bearerToken: endpoint.bearerToken }
							: {}),
						directTools: true,
						lifecycle: "eager" as const,
						toolPrefix: "none" as const,
					},
				]),
			),
		},
	});
}
