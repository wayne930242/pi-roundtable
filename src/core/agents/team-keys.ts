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

/** The surface of a key that is not a Discord channel's; undefined for a Discord channel. */
export const roomSurfaceOf = (room: ChannelKey): string | undefined => {
	const at = typeof room === "string" ? room.indexOf(":") : -1;
	if (at <= 0) return undefined;
	const surface = room.slice(0, at);
	return surface === DISCORD_SURFACE ? undefined : surface;
};

/**
 * An agent's conversation inside a group, apart from its own. In a Discord group channel, or
 * without a room, it is keyed by the channel; in a room of another surface, by the surface and the
 * group's name, so the room's seats are conversations of their own.
 */
export function groupSessionKey(
	group: AgentGroup,
	agent: string,
	room?: ChannelKey,
): ChannelKey {
	const surface = room === undefined ? undefined : roomSurfaceOf(room);
	return surface === undefined
		? `agentgroup:${group.channelId}.${agent}`
		: `agentgroup:${surface}.group.${group.name}.${agent}`;
}

/**
 * The name a group's messages are logged under: the group's own in its Discord channel, and
 * `<group>@<surface>` in a room, so each conversation keeps its own history and cursors.
 */
export function groupLogName(group: AgentGroup, room: ChannelKey): string {
	const surface = roomSurfaceOf(room);
	return surface === undefined ? group.name : `${group.name}@${surface}`;
}

/** An agent's own channel conversation. */
export function homeScope(agent: Agent): AgentTurnScope {
	const home = discordKey(agent.channelId ?? "");
	return { name: agent.name, session: home, home };
}

/** An agent's conversation in its room: the room is its session and its home. */
export function roomScope(agent: Agent, room: ChannelKey): AgentTurnScope {
	return { name: agent.name, session: room, home: room };
}

/**
 * An agent's conversation inside a group: in a Discord group channel, or without a room, as
 * before; in a room, the room's seat, whose home is the agent's own room on that surface.
 */
export function groupScope(
	agent: Agent,
	group: AgentGroup,
	room?: ChannelKey,
): AgentTurnScope {
	const surface = room === undefined ? undefined : roomSurfaceOf(room);
	return {
		name: agent.name,
		session: groupSessionKey(group, agent.name, room),
		home:
			surface === undefined
				? discordKey(agent.channelId ?? "")
				: agentRoomKey(surface, agent.name),
		group: group.name,
	};
}

/**
 * The agent or group that owns a channel of the agent server: by Discord channel, or by room on
 * one of `roomSurfaces`. An archived agent or group owns nothing.
 */
export function channelOwner(
	store: Pick<AgentDirectory, "agentByChannel" | "groupByChannel"> &
		Partial<Pick<AgentDirectory, "agent" | "group">>,
	channel: ChannelKey,
	roomSurfaces: readonly string[] = [],
): "agent" | "group" | undefined {
	const id = discordIdOf(channel);
	if (id === undefined) {
		const room = roomOf(channel, roomSurfaces);
		if (!room) return undefined;
		if (room.kind === "agent")
			return store.agent?.(room.name)?.status === "active"
				? "agent"
				: undefined;
		return store.group?.(room.name)?.status === "active" ? "group" : undefined;
	}
	if (store.agentByChannel(id)) return "agent";
	if (store.groupByChannel(id)) return "group";
	return undefined;
}

/**
 * Every key an agent or group is addressed by: its Discord channel, when it has one, then its
 * room on each of `roomSurfaces`; none for a name the team does not know. Archived ones count,
 * so what they left behind can be cleared.
 */
export function keysOf(
	store: Pick<AgentDirectory, "agent" | "group">,
	name: string,
	roomSurfaces: readonly string[],
): ChannelKey[] {
	const agent = store.agent(name);
	if (agent)
		return [
			...(agent.channelId ? [discordKey(agent.channelId)] : []),
			...roomSurfaces.map((surface) => agentRoomKey(surface, name)),
		];
	const group = store.group(name);
	if (group)
		return [
			...(group.channelId ? [discordKey(group.channelId)] : []),
			...roomSurfaces.map((surface) => groupRoomKey(surface, name)),
		];
	return [];
}
