import { AgentError } from "../domain/errors.ts";
import { assistantName } from "../i18n/index.ts";
import type { ThinkingSetting } from "../models.ts";
import { zonedStamp } from "../time.ts";
import type { ChannelMessage } from "./agent-ports.ts";
import { describeThinking } from "./agent-settings.ts";
import type { Agent, AgentStore } from "./agent-store.ts";

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
export function teamListText(store: Pick<AgentStore, "agents" | "groups">) {
	const agents = store.agents().map((a) => {
		const channel = a.channelId ? `<#${a.channelId}>` : "no channel";
		return `- ${a.name} "${a.displayName}" — ${channel}, ${a.status}`;
	});
	const groups = store
		.groups()
		.map(
			(g) =>
				`- ${g.name} "${g.displayName}" — <#${g.channelId}>, ${g.status}; members ${g.members.join(", ")}; host ${g.host}`,
		);
	return `Agents:\n${agents.join("\n") || "none"}\n\nGroups:\n${groups.join("\n") || "none"}`;
}

/** One agent as agent_get shows it; unset settings name the assistant's. */
export function agentDetails(
	agent: Agent,
	defaults: { model: string; thinking: ThinkingSetting },
	skills: string,
): string {
	return [
		`Name: ${agent.name}`,
		`Display name: ${agent.displayName}`,
		`Status: ${agent.status}`,
		`Channel: ${agent.channelId ? `<#${agent.channelId}>` : "none"}`,
		`Model: ${agent.model ?? `${assistantName()}'s (${defaults.model})`}`,
		`Thinking: ${agent.thinking ?? `${assistantName()}'s (${describeThinking(defaults.thinking)})`}`,
		`Skills: ${skills}`,
		`Avatar prompt: ${agent.avatarPrompt}`,
		`Prompt:\n${agent.prompt}`,
	].join("\n");
}
