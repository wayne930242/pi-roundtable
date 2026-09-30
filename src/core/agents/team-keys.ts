import type { ChannelKey } from "../domain/conversation.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import type { Agent, AgentGroup, AgentStore } from "./agent-store.ts";

export const channelKey = (channelId: string): ChannelKey =>
	`discord:${channelId}`;

export const channelIdOf = (channel: ChannelKey) =>
	channel.slice("discord:".length);

/** An agent's conversation inside a group, apart from its own. */
export const groupSessionKey = (group: AgentGroup, agent: string): ChannelKey =>
	`agentgroup:${group.channelId}.${agent}`;

/** An agent's own conversation. */
export function homeScope(agent: Agent): AgentTurnScope {
	const home = channelKey(agent.channelId ?? "");
	return { name: agent.name, session: home, home };
}

/** An agent's conversation inside a group. */
export function groupScope(agent: Agent, group: AgentGroup): AgentTurnScope {
	return {
		name: agent.name,
		session: groupSessionKey(group, agent.name),
		home: channelKey(agent.channelId ?? ""),
		group: group.name,
	};
}

/** The agent or group that owns a channel of the agent server. */
export function channelOwner(
	store: Pick<AgentStore, "agentByChannel" | "groupByChannel">,
	channel: ChannelKey,
): "agent" | "group" | undefined {
	const id = channelIdOf(channel);
	if (store.agentByChannel(id)) return "agent";
	if (store.groupByChannel(id)) return "group";
	return undefined;
}
