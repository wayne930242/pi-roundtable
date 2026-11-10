import { Type } from "typebox";
import type {
	AgentChannels,
	ChannelMessage,
} from "../contract/agent-channels.ts";
import { AgentError } from "../domain/errors.ts";
import { messages } from "../i18n/index.ts";
import { ownerWords } from "../identity/owner-identity.ts";
import { THE_SPEAKER } from "../identity/speakers.ts";
import type { Logger } from "../kernel/log.ts";
import { timeZone, zonedStamp } from "../kernel/time.ts";
import type { FormerChannelOps } from "../plugin-api/agent-ops.ts";
import {
	defineTool,
	type ToolContribution,
	ToolRefusal,
} from "../plugin-api/define.ts";
import type { AgentDirectory } from "../plugin-api/services.ts";
import {
	categoryLayoutText,
	planArrangement,
	resolveArrangement,
} from "./agent-layout.ts";

/** The most messages `channel_read` returns. */
const READ_LIMIT = 50;

/** One message as channel_read shows it: id, local time, author, text, attachments. */
export function messageLine(message: ChannelMessage): string {
	const files =
		message.attachments.length > 0
			? ` [attachments: ${message.attachments.join(", ")}]`
			: "";
	return `[${message.id}] ${zonedStamp(message.at)} ${message.author}: ${message.text}${files}`;
}

/** A channel given as `<#id>` or its id, as its id. */
export function channelIdFromRef(channel: string): string {
	const id = /^<#(\d+)>$/.exec(channel.trim())?.[1] ?? channel.trim();
	if (!/^\d+$/.test(id))
		throw new AgentError(
			"Give the channel as <#id> or its id, as in a forwarded message.",
		);
	return id;
}

/** The agent or group a channel belongs to, by its name, for the category listing. */
export function ownerNameOf(
	directory: Pick<AgentDirectory, "agentByChannel" | "groupByChannel">,
): (channelId: string) => string | undefined {
	return (id) =>
		directory.agentByChannel(id)?.name ?? directory.groupByChannel(id)?.name;
}

export interface DiscordAgentToolsOptions {
	/** The agent guild's channels, which the tools list, arrange and read. */
	channels: Pick<AgentChannels, "layout" | "arrange" | "read">;
	/** The team's agents and groups, read when a tool runs; undefined on a host whose agent server is off. */
	directory: () =>
		| Pick<
				AgentDirectory,
				"agent" | "group" | "agentByChannel" | "groupByChannel"
		  >
		| undefined;
	logger: Logger;
}

/** A tool that only agents' turns carry: the owner's sessions load none of it. */
function agentsOnly(tool: ToolContribution): ToolContribution {
	return {
		...tool,
		session: {
			...tool.session,
			snapshot: () => {
				// Not required at startup: the sessions the preflight builds are no agent's.
				const { requiredTools: _, factory, ...rest } = tool.session.snapshot();
				return {
					...rest,
					factory: (session) => (session.agent ? factory(session) : null),
				};
			},
		},
	};
}

/** A refusal the model reads, where the tool's own code throws an `AgentError`. */
async function refusing<T>(run: () => Promise<T> | T): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof AgentError) throw new ToolRefusal(error.message);
		throw error;
	}
}

/**
 * What `channel_arrange` and `channel_read` run, and Discord's side of the deprecated
 * `AgentOps.arrange` and `AgentOps.read`, which the host hands the team until 1.0. Each refuses
 * with an `AgentError`.
 */
export function discordChannelOps(
	options: DiscordAgentToolsOptions,
): FormerChannelOps {
	const { channels, logger } = options;
	const directory = () => {
		const found = options.directory();
		if (!found)
			throw new AgentError(
				"This host has no agent team, so there are no agent channels here.",
			);
		return found;
	};
	return {
		arrange: async (entries) => {
			const team = directory();
			const listed = resolveArrangement(entries, team);
			const { layout, remove } = planArrangement(
				listed,
				await channels.layout(),
			);
			await channels.arrange(layout, remove);
			logger.info(
				{ entries: listed.map((l) => l.category), removed: remove.length },
				"agent channels arranged",
			);
			const removed =
				remove.length > 0
					? ` ${remove.length} empty team categories were deleted.`
					: "";
			return `Arranged the channels.${removed}\n\n${categoryLayoutText(await channels.layout(), ownerNameOf(team))}`;
		},
		read: async (channel, around, limit) => {
			const id = channelIdFromRef(channel);
			const found = await channels.read(id, {
				limit: Math.min(Math.max(limit ?? 20, 1), READ_LIMIT),
				...(around ? { around } : {}),
			});
			return found.length > 0
				? found.map(messageLine).join("\n")
				: `<#${id}> has no messages there.`;
		},
	};
}

/**
 * The tools of the agent guild's channels: `channel_arrange` sorts agent and group channels into
 * categories and `channel_read` reads a channel's messages. Agents carry them, as they carried
 * them when the agent team offered them; a temp knight carries neither arrange nor creation.
 */
export function discordAgentTools(
	options: DiscordAgentToolsOptions,
): ToolContribution[] {
	const ops = discordChannelOps(options);
	const speaker = ownerWords(THE_SPEAKER).name;
	return [
		defineTool({
			name: "channel_arrange",
			description: `Sort agent and group channels into categories and order them, when ${speaker} asks. Agents go under Agents or Agents-<suffix>, groups under Groups or Groups-<suffix>; missing categories are made. The listed categories come first in the server in list order, then every other category as it was; in each listed category the listed channels come first in order, then its other channels as they were. Agents and Groups categories left empty are deleted. Any wrong entry refuses the whole call and nothing moves. Read the current layout with agent_list first.`,
			minTier: "admin",
			withheldFromHelpers: true,
			parameters: Type.Object({
				categories: Type.Array(
					Type.Object({
						category: Type.String({
							description:
								"Agents, Groups, or either with -<suffix>, the suffix 1 to 32 characters in any language.",
						}),
						channels: Type.Array(Type.String(), {
							minItems: 1,
							description:
								"Agent or group names (from agent_list), in the order they should appear.",
						}),
					}),
					{ minItems: 1, description: "Categories in server order." },
				),
			}),
			run: ({ categories }) =>
				refusing(() =>
					ops.arrange(
						categories.map((entry) => ({
							category: entry.category,
							names: entry.channels,
						})),
					),
				),
		}),
		defineTool({
			name: "channel_read",
			description: `Read messages of a text channel or thread of the agent server, oldest first, each with its id, ${messages().zoneTime(timeZone())}, author, text, and attachment names. Use it for the surroundings of a message ${speaker} forwarded to you: pass the source channel and the message id from the forwarded link. Read-only.`,
			minTier: "member",
			parameters: Type.Object({
				channel: Type.String({
					description: "The channel as <#id> or its id.",
				}),
				around: Type.Optional(
					Type.String({
						pattern: "^\\d+$",
						description:
							"A message id: read the messages around it instead of the latest.",
					}),
				),
				limit: Type.Optional(
					Type.Integer({ minimum: 1, maximum: 50, description: "Default 20." }),
				),
			}),
			run: ({ channel, around, limit }) =>
				refusing(() => ops.read(channel, around, limit)),
		}),
	].map(agentsOnly);
}
