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
	nameOption: string;
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
	nameOption: "Connector",
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
		`\`/${root} connector add\` adds one; \`describe\` changes its purpose; \`remove\` deletes the connector and its token.`,
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
};

/** The English text with the host's own wording laid over it. */
export function connectorMessages(
	overrides: Partial<ConnectorMessages> = {},
): ConnectorMessages {
	return { ...CONNECTOR_MESSAGES, ...overrides };
}
