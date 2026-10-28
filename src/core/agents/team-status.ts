import type { ThinkingSetting } from "../models.ts";
import type { ContextUse } from "./agent-ports.ts";
import { discordIdOf, keysOf } from "./team-keys.ts";
import type { TeamContext } from "./team-options.ts";

/** An active agent as the dashboard shows it. */
export interface AgentStatus {
	name: string;
	displayName: string;
	channelId?: string;
	model: string;
	thinking: ThinkingSetting;
	/** The channel of its running turn: its own, a group's, or where it answers a message. */
	workingIn?: string;
	/** Turns waiting in its own channel and in each of its rooms. */
	waiting: number;
	/** The context use of its conversation that has one: its Discord channel's, else the first room's. */
	context?: ContextUse;
	lastActive?: Date;
	/** Its schedules, across its Discord channel and its rooms. */
	schedules: number;
}

/** An active group as the dashboard shows it. */
export interface GroupStatus {
	name: string;
	displayName: string;
	/** Its Discord channel; absent in a team without Discord. */
	channelId?: string;
	members: string[];
	host: string;
	/** Messages of its channel and rooms running or waiting, a round counting as one. */
	busy: number;
	lastActive?: Date;
}

export interface TeamStatus {
	agents: AgentStatus[];
	groups: GroupStatus[];
}

/** Every active agent and group, with what each is doing now. */
export async function teamStatus(ctx: TeamContext): Promise<TeamStatus> {
	const { options, turns } = ctx;
	const { store, queue, schedules } = options;
	const runtime = options.runtime();
	const rooms = options.surfaces?.roomSurfaces() ?? [];
	const agents: AgentStatus[] = [];
	for (const agent of store.agents()) {
		if (agent.status !== "active") continue;
		// Its Discord channel and each room are conversations of their own, and all count.
		const keys = keysOf(store, agent.name, rooms);
		const working = turns.workingIn(agent.name);
		// The board links Discord channels; a turn in a room has none to link.
		const workingIn = working === undefined ? undefined : discordIdOf(working);
		const queued = keys.reduce((sum, key) => sum + queue.size(key), 0);
		const context = keys
			.map((key) => runtime.contextUsage?.(key))
			.find((use) => use !== undefined);
		let scheduled = 0;
		for (const key of keys)
			scheduled += (await schedules.forChannel(key)).length;
		const lastActive = turns.lastActive(agent.name);
		agents.push({
			name: agent.name,
			displayName: agent.displayName,
			...(agent.channelId ? { channelId: agent.channelId } : {}),
			...ctx.modelOf(agent.name),
			...(workingIn ? { workingIn } : {}),
			waiting: Math.max(
				0,
				queued - (working !== undefined && keys.includes(working) ? 1 : 0),
			),
			...(context ? { context } : {}),
			...(lastActive ? { lastActive } : {}),
			schedules: scheduled,
		});
	}
	const groups: GroupStatus[] = store.groups().flatMap((group) => {
		if (group.status !== "active") return [];
		const lastActive = turns.lastGroupActive(group.name);
		return [
			{
				name: group.name,
				displayName: group.displayName,
				...(group.channelId ? { channelId: group.channelId } : {}),
				members: group.members.map((m) => store.agent(m)?.displayName ?? m),
				host: store.agent(group.host)?.displayName ?? group.host,
				busy: keysOf(store, group.name, rooms).reduce(
					(sum, key) => sum + queue.size(key),
					0,
				),
				...(lastActive ? { lastActive } : {}),
			},
		];
	});
	return { agents, groups };
}
