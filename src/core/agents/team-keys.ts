import { channelKey, parseChannelKey } from "../contract/surface.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import type { AgentDirectory } from "../services.ts";
import type { Agent, AgentGroup } from "./agent-store.ts";

/** The surface of the channels the agent server runs on. */
const DISCORD_SURFACE = "discord";

/** The key of a Discord channel. */
export const discordKey = (channelId: string): ChannelKey =>
	channelKey(DISCORD_SURFACE, channelId);

/** The Discord channel id of a key, or undefined when the key belongs to another surface. */
export function discordIdOf(channel: ChannelKey): string | undefined {
	const { surface, id } = parseChannelKey(channel);
	return surface === DISCORD_SURFACE ? id : undefined;
}

/** The id part of a key the caller already knows is a Discord one, because the agent server owns it. */
export const channelIdOf = (channel: ChannelKey) => parseChannelKey(channel).id;

/** An agent's conversation inside a group, apart from its own. */
export const groupSessionKey = (group: AgentGroup, agent: string): ChannelKey =>
	`agentgroup:${group.channelId}.${agent}`;

/** An agent's own conversation. */
export function homeScope(agent: Agent): AgentTurnScope {
	const home = discordKey(agent.channelId ?? "");
	return { name: agent.name, session: home, home };
}

/** An agent's conversation inside a group. */
export function groupScope(agent: Agent, group: AgentGroup): AgentTurnScope {
	return {
		name: agent.name,
		session: groupSessionKey(group, agent.name),
		home: discordKey(agent.channelId ?? ""),
		group: group.name,
	};
}

/** The agent or group that owns a channel of the agent server. */
export function channelOwner(
	store: Pick<AgentDirectory, "agentByChannel" | "groupByChannel">,
	channel: ChannelKey,
): "agent" | "group" | undefined {
	const id = discordIdOf(channel);
	if (id === undefined) return undefined;
	if (store.agentByChannel(id)) return "agent";
	if (store.groupByChannel(id)) return "group";
	return undefined;
}
