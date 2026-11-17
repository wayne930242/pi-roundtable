import {
	defineTool,
	type HoldRule,
	serviceKey,
	type ToolContribution,
	ToolRefusal,
	type ToolTurn,
} from "pi-roundtable";
import { Type } from "typebox";
import { displayUrl } from "./connector-input.ts";
import { type Connector, ConnectorError } from "./connector-results.ts";
import type { ConnectorMessages } from "./messages.ts";

/** What a one-time add request carries: never a URL or a token. */
export interface ConnectorAddRequest {
	name: string;
	description: string;
	/** The conversation the request came from, which hears how the add went. */
	conversation: string;
	/** The principal of the owner whose turn asked. */
	requestedBy: string;
}

/**
 * Where the owner pastes a new connector's URL, outside any conversation: pi-roundtable-web's
 * connectors page provides it. `create` answers undefined when no add form reaches the
 * conversation, so the tool sends the owner to `/<root> connector add` instead.
 */
export interface ConnectorAddRequests {
	/** How long a request lasts, in minutes. */
	readonly minutes: number;
	create(request: ConnectorAddRequest): Promise<{ link: string } | undefined>;
}

/** Provided by the web console when it serves the connectors page; matched on its id, so it needs no import. */
export const CONNECTOR_ADD_REQUESTS = serviceKey<ConnectorAddRequests>(
	"pi-roundtable-web.connector-add-requests",
);

/** The hold rule `connector_remove` waits under; yolo mode never approves it. */
export const CONNECTOR_HOLD_RULE = "connector";

const REMOVE = "connector_remove";

export interface ConnectorToolsOptions {
	connectors: () => readonly Connector[];
	remove(name: string): Promise<void>;
	/** The add requests, read at each call; undefined on a host without the web console's form. */
	requests: () => ConnectorAddRequests | undefined;
	/** The Discord command that adds a connector, such as `/rt connector add`; undefined without Discord. */
	command: () => string | undefined;
	text: ConnectorMessages;
}

const hostOf = (connector: Connector, text: ConnectorMessages) =>
	displayUrl(connector.url, text.urlUnreadable);

/** Holds every `connector_remove` call with the connector's name and host, never its URL. */
export function connectorHoldRule(
	options: Pick<ConnectorToolsOptions, "connectors" | "text">,
): HoldRule {
	return {
		name: CONNECTOR_HOLD_RULE,
		yolo: "never",
		describe: (tool, input) => {
			if (tool !== REMOVE) return undefined;
			const name = typeof input.name === "string" ? input.name : "";
			const found = options.connectors().find((c) => c.name === name);
			return options.text.removeHold(
				name,
				found ? hostOf(found, options.text) : "?",
			);
		},
	};
}

function ownerOnly(turn: Pick<ToolTurn, "speaker">, text: ConnectorMessages) {
	if (turn.speaker?.tier !== "owner") throw new ToolRefusal(text.toolOwnerOnly);
}

const NO_URL =
	"Never ask the owner to paste a connector's URL or token into the chat: it carries a secret. If they already did, do not repeat it anywhere; give them the link instead, and suggest they delete that message and rotate the token.";

const ADD_PARAMETERS = Type.Object(
	{
		name: Type.String({
			description:
				"The connector's name: lowercase letters, digits and -, up to 12, starting with a letter",
			maxLength: 12,
		}),
		description: Type.Optional(
			Type.String({
				description:
					"What the connector is for; the agents decide from it when to use it",
				maxLength: 1000,
			}),
		),
	},
	{ additionalProperties: false },
);

const REMOVE_PARAMETERS = Type.Object(
	{
		name: Type.String({
			description: "The connector's name, as connector_list shows it",
		}),
	},
	{ additionalProperties: false },
);

/** What the tools take; none has a field for a URL or a token. */
export const CONNECTOR_TOOL_PARAMETERS = {
	connector_list: Type.Object({}, { additionalProperties: false }),
	connector_add: ADD_PARAMETERS,
	connector_remove: REMOVE_PARAMETERS,
} as const;

type Turn = Pick<ToolTurn, "speaker" | "channel">;

/** What the tools do, apart from their schemas. */
export function connectorActs(options: ConnectorToolsOptions) {
	const { text } = options;
	const known = (name: string) => {
		const all = options.connectors();
		const found = all.find((c) => c.name === name);
		if (!found)
			throw new ToolRefusal(
				text.toolUnknownConnector(name, all.map((c) => c.name).join(", ")),
			);
		return found;
	};
	return {
		list(): string {
			const all = options.connectors();
			if (all.length === 0) return text.toolListEmpty;
			return all
				.map((c) =>
					text.toolListLine(
						c.name,
						hostOf(c, text),
						c.server?.tools.length,
						c.description,
					),
				)
				.join("\n");
		},
		async add(
			args: { name: string; description?: string },
			turn: Turn,
		): Promise<string> {
			ownerOnly(turn, text);
			const extra = Object.keys(args).filter(
				(key) => key !== "name" && key !== "description",
			);
			if (extra.length > 0)
				throw new ToolRefusal(
					`connector_add takes only name and description. ${NO_URL}`,
				);
			const name = args.name.trim();
			if (options.connectors().some((c) => c.name === name))
				throw new ToolRefusal(text.nameTaken(name));
			const requests = options.requests();
			const made = await requests?.create({
				name,
				description: args.description?.trim() ?? "",
				conversation: turn.channel,
				requestedBy: turn.speaker?.principalId ?? "",
			});
			if (!requests || !made) return text.toolAddElsewhere(options.command());
			return text.toolAddLink(name, made.link, requests.minutes);
		},
		async remove(args: { name: string }, turn: Turn): Promise<string> {
			ownerOnly(turn, text);
			const { name } = known(args.name);
			try {
				await options.remove(name);
			} catch (error) {
				if (error instanceof ConnectorError)
					throw new ToolRefusal(error.message);
				throw error;
			}
			return text.toolRemoved(name);
		},
	};
}

/** `connector_list`, `connector_add` and `connector_remove`: the owner's connectors, never their URLs. */
export function connectorTools(
	options: ConnectorToolsOptions,
): ToolContribution[] {
	const acts = connectorActs(options);
	return [
		defineTool({
			name: "connector_list",
			description:
				"Lists the owner's MCP connectors: name, host, whether its tools can be read and how many, and its purpose. The full URL is never shown.",
			parameters: CONNECTOR_TOOL_PARAMETERS.connector_list,
			minTier: "member",
			run: () => acts.list(),
		}),
		defineTool({
			name: "connector_add",
			description: `Starts adding an MCP connector for the owner. It takes no URL: it returns a one-time link to the owner's add form, with the name and purpose filled in, where the owner pastes the URL; you get a message in this conversation when the add finishes. ${NO_URL}`,
			parameters: ADD_PARAMETERS,
			minTier: "owner",
			run: (args, turn) => acts.add(args, turn),
		}),
		defineTool({
			name: REMOVE,
			description:
				"Removes one of the owner's MCP connectors, with its token and its tools, after the owner approves it on a card.",
			parameters: REMOVE_PARAMETERS,
			minTier: "owner",
			run: (args, turn) => acts.remove(args, turn),
		}),
	];
}
