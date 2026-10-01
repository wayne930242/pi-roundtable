// The package's one entry: two plugins, their options, and the service the connectors plugin provides.

export type {
	Connector,
	ConnectorProfileSource,
	NewConnector,
} from "./connectors/connector-registry.ts";
export type {
	Connectors,
	ContextForgeOptions,
	McpConnectorsOptions,
} from "./connectors/connectors-plugin.ts";
export { CONNECTORS, mcpConnectors } from "./connectors/connectors-plugin.ts";
export type { UpstreamAuth } from "./connectors/contextforge.ts";
export type { ConnectorMessages } from "./connectors/messages.ts";
export type { RemoteMcpMessages } from "./remote-mcp/messages.ts";
export type { RemoteClaimHooks } from "./remote-mcp/remote-claim.ts";
export type {
	DefaultConversationOptions,
	HostConversationOptions,
	RemoteMcpOptions,
} from "./remote-mcp/remote-mcp-plugin.ts";
export { remoteMcp } from "./remote-mcp/remote-mcp-plugin.ts";
