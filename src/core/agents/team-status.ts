import type { ThinkingSetting } from "../models.ts";
import type { ContextUse } from "./agent-ports.ts";
import { channelIdOf, discordKey } from "./team-keys.ts";
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
	/** Turns waiting in its own channel. */
	waiting: number;
	context?: ContextUse;
	lastActive?: Date;
	schedules: number;
}

/** An active group as the dashboard shows it. */
export interface GroupStatus {
	name: string;
	displayName: string;
	channelId: string;
	members: string[];
	host: string;
	/** Messages of its channel running or waiting, a round counting as one. */
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
	const agents: AgentStatus[] = [];
	for (const agent of store.agents()) {
		if (agent.status !== "active") continue;
		const home = agent.channelId ? discordKey(agent.channelId) : undefined;
		const workingIn = turns.workingIn(agent.name);
		const queued = home ? queue.size(home) : 0;
		const context = home ? runtime.contextUsage?.(home) : undefined;
		const lastActive = turns.lastActive(agent.name);
		agents.push({
			name: agent.name,
			displayName: agent.displayName,
			...(agent.channelId ? { channelId: agent.channelId } : {}),
			...ctx.modelOf(agent.name),
			...(workingIn ? { workingIn: channelIdOf(workingIn) } : {}),
			waiting: Math.max(0, queued - (workingIn === home ? 1 : 0)),
			...(context ? { context } : {}),
			...(lastActive ? { lastActive } : {}),
			schedules: home ? (await schedules.forChannel(home)).length : 0,
		});
	}
	const groups: GroupStatus[] = store.groups().flatMap((group) => {
		if (group.status !== "active") return [];
		const lastActive = turns.lastGroupActive(group.name);
		return [
			{
				name: group.name,
				displayName: group.displayName,
				channelId: group.channelId,
				members: group.members.map((m) => store.agent(m)?.displayName ?? m),
				host: store.agent(group.host)?.displayName ?? group.host,
				busy: queue.size(discordKey(group.channelId)),
				...(lastActive ? { lastActive } : {}),
			},
		];
	});
	return { agents, groups };
}
