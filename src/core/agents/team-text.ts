import { CATALOG, type CharacterSpec } from "../../characters/index.ts";
import { AgentError } from "../domain/errors.ts";
import { assistantName } from "../i18n/index.ts";
import type { ThinkingSetting } from "../models.ts";
import type { AgentDirectory } from "../services.ts";
import { zonedStamp } from "../time.ts";
import type { ChannelMessage } from "./agent-ports.ts";
import { characterOf, isHelper } from "./agent-rules.ts";
import { describeThinking } from "./agent-settings.ts";
import type { Agent } from "./agent-store.ts";

/** Said by the tools that work on Discord channels when the team has none. */
export const NO_CHANNELS =
	"This host has no Discord channels: the agents live in rooms of a chat surface, so there is nothing to arrange or read here.";

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

/** Every agent and group as agent_list shows them, before the category layout. */
export function teamListText(store: Pick<AgentDirectory, "agents" | "groups">) {
	const all = store.agents();
	const line = (a: Agent, indent: string) => {
		const channel = a.channelId ? `<#${a.channelId}>` : "no channel";
		const temp = isHelper(a)
			? ` (temp, of ${a.parent}, ${a.finishedAt ? "finished" : "working"})`
			: "";
		return `${indent}- ${a.name}${temp} "${a.displayName}" — ${channel}, ${a.status}`;
	};
	// A temp knight is listed under its parent.
	const agents = all
		.filter((a) => !isHelper(a))
		.flatMap((a) => [
			line(a, ""),
			...all.filter((h) => h.parent === a.name).map((h) => line(h, "  ")),
		]);
	const groups = store
		.groups()
		.map(
			(g) =>
				`- ${g.name} "${g.displayName}" — ${g.channelId ? `<#${g.channelId}>` : "no channel"}, ${g.status}; members ${g.members.join(", ")}; host ${g.host}`,
		);
	return `Agents:\n${agents.join("\n") || "none"}\n\nGroups:\n${groups.join("\n") || "none"}`;
}

/** A look in a few words: the class label, then the palette or the primary color. */
export function lookText(character: CharacterSpec): string {
	return `${CATALOG.classes[character.class].label}, ${character.palette ?? character.colors.primary}`;
}

/** One agent as agent_get shows it; unset settings name the assistant's, and no skills line while the skills addon is off. */
export function agentDetails(
	agent: Agent,
	defaults: { model: string; thinking: ThinkingSetting },
	skills: string | undefined,
	conversations: readonly string[] = [],
): string {
	return [
		`Name: ${agent.name}`,
		`Display name: ${agent.displayName}`,
		`Status: ${agent.status}`,
		...(isHelper(agent)
			? [
					`Temp knight of: ${agent.parent} (${agent.finishedAt ? "finished" : "working"})`,
				]
			: []),
		`Channel: ${agent.channelId ? `<#${agent.channelId}>` : "none"}`,
		...(conversations.length === 0
			? []
			: [`Conversations: ${conversations.join(", ")}`]),
		`Model: ${agent.model ?? `${assistantName()}'s (${defaults.model})`}`,
		`Thinking: ${agent.thinking ?? `${assistantName()}'s (${describeThinking(defaults.thinking)})`}`,
		...(skills === undefined ? [] : [`Skills: ${skills}`]),
		`Look: ${lookText(characterOf(agent))}`,
		`Prompt:\n${agent.prompt}`,
	].join("\n");
}
