/** The text the connectors plugin shows the owner on Discord, and the refusals the registry raises. */
export interface ConnectorMessages {
	nameRule: string;
	urlRule: string;
	purposeRequired: string;
	purposeEmpty: string;
	nameTaken(name: string): string;
	noTools: string;
	toolsTooLong(max: number, names: readonly string[]): string;
	unknownConnector(name: string): string;

	groupDescription: string;
	addDescription: string;
	listDescription: string;
	describeDescription: string;
	removeDescription: string;
	resyncDescription: string;
	nameOption: string;
	/** The connector option of `resync`, which may be left empty. */
	resyncNameOption: string;
	newPurposeOption: string;

	modalTitle: string;
	nameLabel: string;
	nameHelp: string;
	urlLabel: string;
	urlHelp: string;
	purposeLabel: string;
	purposeHelp: string;
	headerLabel: string;
	headerHelp: string;
	tokenLabel: string;
	tokenHelp: string;

	headerNeedsToken: string;
	headerRule: string;
	urlUnreadable: string;

	/** The tool line of a connector: how many it has, the first few, and how many are left out of the list. */
	toolCount(total: number, listed: string, hidden: number): string;
	toolsUnreadable: string;
	listTitle: string;
	listEmpty(root: string): string;
	listFooter(root: string): string;
	purposeUpdatedTitle: string;
	purposeUpdatedFooter: string;
	removedTitle: string;
	removed(name: string): string;
	addedTitle: string;
	addedFooter: string;
	skippedTools(names: string): string;
	resyncedTitle: string;
	resyncedAllTitle: string;
	resyncedFooter: string;
	/** What a resync changed in a connector's tools; `added` and `removed` are lists of tool names, empty when none. */
	resyncChanges(added: string, removed: string): string;
	resyncUnchanged: string;
	/** One connector of a resync that failed; `reason` is why. Once the gateway had read its upstream, the virtual server may serve fewer tools until the next resync. */
	resyncFailed(name: string, reason: string): string;
	/** A resync that sent no request, because the gateway refused the admin account (its request limit, or a lock) on an earlier one; the tools are as before. */
	resyncNotAttempted: string;

	/** Between a connector's name and its address in the list; the English default is two spaces. */
	labelSeparator: string;
	/** The description ContextForge shows on a new connector's virtual server. */
	serverDescription(name: string, description: string): string;
	/** Refuses an upstream URL that cannot be parsed; `url` is the address as the owner gave it. */
	upstreamUrlUnreadable(url: string): string;
	/** ContextForge accepted a new upstream server but returned no gateway ID. */
	contextForgeNoGatewayId: string;
	/** ContextForge could not refresh an upstream server's tools; `detail` is its reason. */
	contextForgeRefreshFailed(detail: string): string;
	/** ContextForge accepted a new virtual server but returned no ID. */
	contextForgeNoServerId: string;
	/** ContextForge refused an admin request; `detail` is its reason, with credentials masked. */
	contextForgeRefused(status: number, detail: string): string;
	/** ContextForge answered an admin request with something other than JSON; `detail` is masked. */
	contextForgeNotJson(detail: string): string;
	/** Reading a virtual server's endpoint and tools failed with `status`; raised at startup. */
	virtualServerRequestFailed(
		url: string,
		status: number,
		detail: string,
	): string;
	/** ContextForge has no virtual server of this name; raised at startup. */
	virtualServerMissing(name: string): string;
	/** The virtual server exists but serves no tools; raised at startup. */
	virtualServerNoTools(name: string): string;
	/**
	 * What an owner's approval card says about a tool call held because its server's hints mark it
	 * destructive (`"destructive"`) or not read-only (`"writes"`); the card lists the input beside it.
	 */
	toolHintHold(
		tool: string,
		server: string,
		why: "destructive" | "writes",
	): string;
}

export const CONNECTOR_MESSAGES: ConnectorMessages = {
	nameRule:
		"Use lowercase letters, digits and `-`, start with a letter, and keep it to 12 characters.",
	urlRule: "The URL must start with `https://` or `http://`.",
	purposeRequired:
		"Describe what this connector is for; the agent uses it to decide when to call it.",
	purposeEmpty: "The purpose cannot be empty.",
	nameTaken: (name) => `The name \`${name}\` is already taken. Pick another.`,
	noTools: "This MCP server offers no tools.",
	toolsTooLong: (max, names) =>
		`Every tool name is longer than ${max} characters, which the model cannot use: ${names.join(", ")}`,
	unknownConnector: (name) => `There is no connector named \`${name}\`.`,

	groupDescription: "External MCP connectors the agent can use",
	addDescription: "Add an MCP connector that connects with a token",
	listDescription: "List every connector and its tools",
	describeDescription:
		"Change a connector's purpose, which the agent uses to decide when to call it",
	removeDescription: "Delete a connector and its token",
	resyncDescription:
		"Read a connector's tools from its server again, or every connector's when none is named",
	nameOption: "Connector",
	resyncNameOption: "Connector (leave empty for all)",
	newPurposeOption: "The new purpose",

	modalTitle: "Add an MCP connector",
	nameLabel: "Name",
	nameHelp:
		"Lowercase letters, digits and -, up to 12; it becomes the prefix of its tool names",
	urlLabel: "MCP URL",
	urlHelp:
		"A Streamable HTTP endpoint; one ending in /sse uses SSE. A credential may be part of the URL",
	purposeLabel: "Purpose",
	purposeHelp: "The agent decides from this text when to use the connector",
	headerLabel: "Header name (optional)",
	headerHelp: "Leave empty to send Authorization: Bearer <token>",
	tokenLabel: "Token (optional)",
	tokenHelp:
		"Handed to ContextForge to store encrypted; leave empty if the credential is in the URL",

	headerNeedsToken: "A header name needs a token with it.",
	headerRule: "A header name may use letters, digits and `-` only.",
	urlUnreadable: "(the URL cannot be parsed)",

	toolCount: (total, listed, hidden) =>
		`-# ${total} tools: ${listed}${hidden > 0 ? ` and ${hidden} more` : ""}`,
	toolsUnreadable:
		"-# The tools cannot be read, so the agent will not use it for now; see the log for the reason.",
	listTitle: "MCP connectors",
	listEmpty: (root) =>
		`No connectors yet. Add one with \`/${root} connector add\`.`,
	listFooter: (root) =>
		`\`/${root} connector add\` adds one; \`describe\` changes its purpose; \`resync\` reads its tools again; \`remove\` deletes the connector and its token.`,
	purposeUpdatedTitle: "Purpose updated",
	purposeUpdatedFooter:
		"From the next message on, the agent follows the new purpose.",
	removedTitle: "Connector removed",
	removed: (name) =>
		`**${name}** and its token are deleted; from the next message on, the agent no longer uses it.`,
	addedTitle: "Connector added",
	addedFooter:
		"From the next message on, questions that need it go to this connector's tools.",
	skippedTools: (names) =>
		`**Skipped tools**  Their names are too long for the model: ${names}`,
	resyncedTitle: "Connector resynced",
	resyncedAllTitle: "Connectors resynced",
	resyncedFooter:
		"From the next message on, the agent sees the tools as listed here.",
	resyncChanges: (added, removed) =>
		[added && `**Added**  ${added}`, removed && `**Removed**  ${removed}`]
			.filter(Boolean)
			.join("\n"),
	resyncUnchanged: "-# The tools are as before.",
	resyncFailed: (name, reason) =>
		`**${name}** could not be resynced: ${reason}. If the gateway had already read the server, the connector may offer fewer tools until the next resync.`,
	resyncNotAttempted:
		"Not resynced: ContextForge refused the admin account (its request limit, or a lock), so no request was sent and the tools are as before. Try again in about 15 minutes.",

	labelSeparator: "  ",
	serverDescription: (name, description) => `Connector ${name}: ${description}`,
	upstreamUrlUnreadable: (url) => `Cannot parse the upstream URL: ${url}`,
	contextForgeNoGatewayId: "ContextForge did not return the gateway ID.",
	contextForgeRefreshFailed: (detail) =>
		`ContextForge could not read the server's tools again: ${detail}`,
	contextForgeNoServerId: "ContextForge did not return the virtual server ID.",
	contextForgeRefused: (status, detail) =>
		`ContextForge answered ${status}: ${detail}`,
	contextForgeNotJson: (detail) =>
		`ContextForge did not answer with JSON: ${detail}`,
	virtualServerRequestFailed: (url, status, detail) =>
		`ContextForge ${url} answered ${status}: ${detail}`,
	virtualServerMissing: (name) =>
		`ContextForge has no virtual server named ${name}`,
	virtualServerNoTools: (name) => `virtual server ${name} serves no tools`,
	toolHintHold: (tool, server, why) =>
		`call ${tool} on ${server}, which its server marks ${why === "destructive" ? "destructive" : "not read-only"}`,
};

/** The English text with the host's own wording laid over it. */
export function connectorMessages(
	overrides: Partial<ConnectorMessages> = {},
): ConnectorMessages {
	return { ...CONNECTOR_MESSAGES, ...overrides };
}
