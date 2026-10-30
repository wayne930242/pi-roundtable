import { AgentError } from "../domain/errors.ts";
import type { Agent, AgentGroup } from "./agent-rules.ts";
import {
	checkAgentName,
	checkDisplayName,
	isHelper,
	MAX_GROUP_MEMBERS,
	MIN_GROUP_MEMBERS,
} from "./agent-rules.ts";
import {
	type AgentRow,
	type GroupRow,
	toAgent,
	toGroup,
} from "./agent-schema.ts";

/**
 * The agents and groups a guild holds in memory, and the checks that read them: every inbound
 * message asks, and only this process changes them. The store writes the rows and keeps these
 * maps in step.
 */
export abstract class AgentBook {
	protected readonly agentMap = new Map<string, Agent>();
	/** Agents whose character column holds a value, readable or not. */
	protected readonly dressed = new Set<string>();
	protected readonly groupMap = new Map<string, AgentGroup>();

	agents(): Agent[] {
		return [...this.agentMap.values()];
	}

	agent(name: string): Agent | undefined {
		return this.agentMap.get(name);
	}

	/** The active agent with that name, or an error the caller can show. */
	activeAgent(name: string): Agent {
		const agent = this.agentMap.get(name);
		if (!agent)
			throw new AgentError(
				`There is no agent "${name}". Active agents: ${this.activeNames()}.`,
			);
		if (agent.status !== "active")
			throw new AgentError(
				`Agent "${name}" is archived. Active agents: ${this.activeNames()}.`,
			);
		return agent;
	}

	agentByChannel(channelId: string): Agent | undefined {
		for (const agent of this.agentMap.values())
			if (agent.channelId === channelId && agent.status === "active")
				return agent;
		return undefined;
	}

	/** The temp knights `parent` made, active and archived, or only those of one `status`. */
	helpersOf(parent: string, status?: Agent["status"]): Agent[] {
		return this.agents().filter(
			(agent) =>
				agent.parent === parent &&
				(status === undefined || agent.status === status),
		);
	}

	/** Whether marking the agent finished (or working, with `false`) changes an active temp knight's stamp. */
	protected stampChanges(name: string, finished: boolean): boolean {
		const agent = this.agentMap.get(name);
		return (
			isHelper(agent) &&
			agent?.status === "active" &&
			(agent.finishedAt !== undefined) !== finished
		);
	}

	/** A temp knight's parent must be an active permanent knight: depth is one. */
	protected checkParent(parent: string): void {
		const agent = this.activeAgent(parent);
		if (isHelper(agent))
			throw new AgentError(
				`"${parent}" is a temp knight, and a temp knight cannot make temp knights.`,
			);
	}

	groups(): AgentGroup[] {
		return [...this.groupMap.values()];
	}

	group(name: string): AgentGroup | undefined {
		return this.groupMap.get(name);
	}

	groupByChannel(channelId: string): AgentGroup | undefined {
		for (const group of this.groupMap.values())
			if (group.channelId === channelId && group.status === "active")
				return group;
		return undefined;
	}

	protected activeNames(): string {
		return (
			this.agents()
				.flatMap((a) => (a.status === "active" ? [a.name] : []))
				.join(", ") || "none"
		);
	}

	/** Names are shared between agents and groups, archived ones included. */
	protected checkFree(name: string): void {
		if (this.agentMap.has(name) || this.groupMap.has(name))
			throw new AgentError(
				`The name "${name}" is taken, archived agents and groups included.`,
			);
	}

	/** A name that createAgent would accept, checked before its channel is made. */
	checkNewName(name: string): void {
		checkAgentName(name);
		this.checkFree(name);
	}

	protected keepAgent(row: AgentRow | undefined): Agent {
		if (!row) throw new AgentError("the agent was not found");
		return this.keepAgentRow(row);
	}

	protected keepAgentRow(row: AgentRow): Agent {
		const agent = toAgent(row);
		this.agentMap.set(agent.name, agent);
		if (row.character !== null && row.character !== undefined)
			this.dressed.add(agent.name);
		else this.dressed.delete(agent.name);
		return agent;
	}

	/** Whether the stored column holds a character, even one this version cannot read. */
	hasStoredCharacter(name: string): boolean {
		return this.dressed.has(name);
	}

	protected checkMembers(members: readonly string[], host: string): void {
		if (
			new Set(members).size !== members.length ||
			members.length < MIN_GROUP_MEMBERS ||
			members.length > MAX_GROUP_MEMBERS
		)
			throw new AgentError(
				`A group has ${MIN_GROUP_MEMBERS} to ${MAX_GROUP_MEMBERS} different members.`,
			);
		for (const member of members)
			if (isHelper(this.activeAgent(member)))
				throw new AgentError(
					`"${member}" is a temp knight and sits at no table; a group takes permanent knights only.`,
				);
		if (!members.includes(host))
			throw new AgentError(`The host "${host}" must be one of the members.`);
	}

	/** Checks a new group before its channel is made; a `displayName` is checked too. */
	checkNewGroup(
		name: string,
		members: readonly string[],
		host: string,
		displayName?: string,
	): void {
		checkAgentName(name);
		if (displayName !== undefined) checkDisplayName(displayName);
		this.checkFree(name);
		this.checkMembers(members, host);
	}

	/** The archived group, when it could be restored now; otherwise the error that says why not. */
	checkRestorableGroup(name: string): AgentGroup {
		const current = this.groupMap.get(name);
		if (!current) throw new AgentError(`There is no group "${name}".`);
		if (current.status === "active")
			throw new AgentError(`"${name}" is not archived.`);
		this.checkMembers(current.members, current.host);
		return current;
	}

	protected keepGroup(row: GroupRow | undefined): AgentGroup {
		if (!row) throw new AgentError("the group was not found");
		const group = toGroup(row);
		this.groupMap.set(group.name, group);
		return group;
	}
}
