import { channelKey, parseChannelKey } from "../contract/surface.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import type { AgentDirectory } from "../plugin-api/services.ts";
import type { Agent } from "./agent-store.ts";
import type { TeamPlaces } from "./team-places.ts";

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

/** The key of an agent's room on a surface that serves agent rooms. */
export const agentRoomKey = (surface: string, agent: string): ChannelKey =>
	channelKey(surface, `agent.${agent}`);

/** The key of a group's room on a surface that serves agent rooms. */
export const groupRoomKey = (surface: string, group: string): ChannelKey =>
	channelKey(surface, `group.${group}`);

const ROOM_ID = /^(agent|group)\.([a-z0-9-]{1,32})$/;

/**
 * Which agent's or group's room a key is, when its surface is one of `roomSurfaces` and its id has
 * the exact shape of a room; undefined for anything else, so no other key is ever taken for one.
 * Discord never hosts rooms.
 */
export function roomOf(
	key: ChannelKey,
	roomSurfaces: readonly string[],
): { kind: "agent" | "group"; name: string } | undefined {
	const at = typeof key === "string" ? key.indexOf(":") : -1;
	if (at <= 0) return undefined;
	const surface = key.slice(0, at);
	if (surface === DISCORD_SURFACE || !roomSurfaces.includes(surface))
		return undefined;
	const match = ROOM_ID.exec(key.slice(at + 1));
	if (!match) return undefined;
	return { kind: match[1] as "agent" | "group", name: match[2] as string };
}

/**
 * The coordinator: with Discord, the agent in the entry channel; without it, the agent the
 * configuration names. Undefined while none is active.
 */
export function coordinatorOf(
	store: Pick<AgentDirectory, "agent">,
	places: Pick<TeamPlaces, "agentOf">,
	team: {
		entryChannelId?: string;
		coordinator?: string | (() => string | undefined);
	},
): Agent | undefined {
	if (team.entryChannelId !== undefined)
		return places.agentOf(discordKey(team.entryChannelId));
	const name =
		typeof team.coordinator === "function"
			? team.coordinator()
			: team.coordinator;
	const named = name ? store.agent(name) : undefined;
	return named?.status === "active" ? named : undefined;
}
