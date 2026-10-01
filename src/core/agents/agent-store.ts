import type { SQL } from "bun";
import type { Migration } from "../db/migrations.ts";
import { AgentError } from "../domain/errors.ts";
import type { ThinkingLevel } from "../models.ts";
import type { AgentDirectory } from "../services.ts";
import {
	type Agent,
	type AgentGroup,
	type AgentSeed,
	type AgentStatus,
	type Backlog,
	checkAgentName,
	checkAvatarPrompt,
	checkDisplayName,
	checkModelRef,
	checkPrompt,
	checkThinking,
	type GroupMessage,
	MAX_GROUP_MEMBERS,
	MIN_GROUP_MEMBERS,
} from "./agent-rules.ts";
import {
	type AgentRow,
	agentMigrations,
	agentsMigration,
	type GroupRow,
	toAgent,
	toGroup,
} from "./agent-schema.ts";
import { GroupMessages } from "./group-messages.ts";

export {
	type Agent,
	type AgentGroup,
	type AgentSeed,
	type AgentStatus,
	type Backlog,
	checkAgentName,
	checkAvatarPrompt,
	checkDisplayName,
	checkModelRef,
	checkPrompt,
	checkThinking,
	type GroupMessage,
	MAX_AVATAR_PROMPT_CHARS,
	MAX_GROUP_MEMBERS,
	MAX_PROMPT_CHARS,
	MIN_GROUP_MEMBERS,
} from "./agent-rules.ts";

/**
 * Agents, groups, and group messages, in the database. Agents and groups are also held
 * in memory, because every inbound message asks and only this process changes them.
 */
export class PgAgentStore implements AgentDirectory {
	readonly #sql: SQL;
	readonly #agents = new Map<string, Agent>();
	readonly #groups = new Map<string, AgentGroup>();

	readonly #guild: string;
	readonly #messages: GroupMessages;

	private constructor(sql: SQL, guildId: string) {
		this.#sql = sql;
		this.#guild = guildId;
		this.#messages = new GroupMessages(sql, guildId);
	}

	/** The store's tables; the host runs this before any store attaches. */
	static readonly migration: Migration = agentsMigration;

	/** The migrations of the store's tables for the guild the process serves. */
	static migrations(guildId: string): Migration[] {
		return agentMigrations(guildId);
	}

	/** The store over the host's migrated pool, holding the rows of one guild. */
	static async attach(sql: SQL, guildId: string): Promise<PgAgentStore> {
		const store = new PgAgentStore(sql, guildId);
		await store.#reload();
		return store;
	}

	async #reload(): Promise<void> {
		const agents: AgentRow[] = await this
			.#sql`SELECT * FROM agents WHERE guild_id = ${this.#guild}`;
		const groups: GroupRow[] = await this
			.#sql`SELECT * FROM agent_groups WHERE guild_id = ${this.#guild}`;
		this.#agents.clear();
		this.#groups.clear();
		for (const row of agents) this.#agents.set(row.name, toAgent(row));
		for (const row of groups) this.#groups.set(row.name, toGroup(row));
	}

	/** Inserts seed agents that do not exist yet; existing rows, edited or not, are left alone. */
	async seed(seeds: readonly AgentSeed[]): Promise<string[]> {
		const added: string[] = [];
		for (const seed of seeds) {
			const rows: unknown[] = await this.#sql`
				INSERT INTO agents (guild_id, name, display_name, prompt, avatar_prompt, channel_id)
				VALUES (${this.#guild}, ${seed.name}, ${seed.displayName}, ${seed.prompt}, ${seed.avatarPrompt},
					${seed.channelId ?? null})
				ON CONFLICT DO NOTHING
				RETURNING name`;
			if (rows.length > 0) added.push(seed.name);
		}
		await this.#reload();
		return added;
	}

	agents(): Agent[] {
		return [...this.#agents.values()];
	}

	agent(name: string): Agent | undefined {
		return this.#agents.get(name);
	}

	/** The active agent with that name, or an error the caller can show. */
	activeAgent(name: string): Agent {
		const agent = this.#agents.get(name);
		if (!agent)
			throw new AgentError(
				`There is no agent "${name}". Active agents: ${this.#activeNames()}.`,
			);
		if (agent.status !== "active")
			throw new AgentError(
				`Agent "${name}" is archived. Active agents: ${this.#activeNames()}.`,
			);
		return agent;
	}

	agentByChannel(channelId: string): Agent | undefined {
		for (const agent of this.#agents.values())
			if (agent.channelId === channelId && agent.status === "active")
				return agent;
		return undefined;
	}

	groups(): AgentGroup[] {
		return [...this.#groups.values()];
	}

	group(name: string): AgentGroup | undefined {
		return this.#groups.get(name);
	}

	groupByChannel(channelId: string): AgentGroup | undefined {
		for (const group of this.#groups.values())
			if (group.channelId === channelId && group.status === "active")
				return group;
		return undefined;
	}

	#activeNames(): string {
		return (
			this.agents()
				.filter((a) => a.status === "active")
				.map((a) => a.name)
				.join(", ") || "none"
		);
	}

	/** Names are shared between agents and groups, archived ones included. */
	#checkFree(name: string): void {
		if (this.#agents.has(name) || this.#groups.has(name))
			throw new AgentError(
				`The name "${name}" is taken, archived agents and groups included.`,
			);
	}

	async createAgent(agent: {
		name: string;
		displayName: string;
		prompt: string;
		avatarPrompt: string;
		channelId: string;
	}): Promise<Agent> {
		checkAgentName(agent.name);
		checkDisplayName(agent.displayName);
		checkPrompt(agent.prompt);
		// An agent of a host without an image provider has no avatar prompt.
		if (agent.avatarPrompt !== "") checkAvatarPrompt(agent.avatarPrompt);
		this.#checkFree(agent.name);
		const rows: AgentRow[] = await this.#sql`
			INSERT INTO agents (guild_id, name, display_name, prompt, avatar_prompt, channel_id)
			VALUES (${this.#guild}, ${agent.name}, ${agent.displayName.trim()}, ${agent.prompt}, ${agent.avatarPrompt},
				${agent.channelId})
			RETURNING *`;
		return this.#keepAgent(rows[0]);
	}

	/** A name that createAgent would accept, checked before its channel is made. */
	checkNewName(name: string): void {
		checkAgentName(name);
		this.#checkFree(name);
	}

	async updateAgent(
		name: string,
		change: {
			displayName?: string;
			prompt?: string;
			avatarPrompt?: string;
			avatarHash?: string;
			channelId?: string;
			/** `null` returns it to the assistant's. */
			model?: string | null;
			thinking?: ThinkingLevel | null;
		},
	): Promise<Agent> {
		const current = this.activeAgent(name);
		if (change.displayName !== undefined) checkDisplayName(change.displayName);
		if (change.prompt !== undefined) checkPrompt(change.prompt);
		if (change.avatarPrompt !== undefined)
			checkAvatarPrompt(change.avatarPrompt);
		if (change.model) checkModelRef(change.model);
		if (change.thinking) checkThinking(change.thinking);
		const model =
			change.model === undefined ? (current.model ?? null) : change.model;
		const thinking =
			change.thinking === undefined
				? (current.thinking ?? null)
				: change.thinking;
		const rows: AgentRow[] = await this.#sql`
			UPDATE agents SET
				display_name = ${change.displayName?.trim() ?? current.displayName},
				prompt = ${change.prompt ?? current.prompt},
				avatar_prompt = ${change.avatarPrompt ?? current.avatarPrompt},
				avatar_hash = ${change.avatarHash ?? current.avatarHash ?? null},
				channel_id = ${change.channelId ?? current.channelId ?? null},
				model = ${model},
				thinking = ${thinking},
				updated_at = now()
			WHERE guild_id = ${this.#guild} AND name = ${name}
			RETURNING *`;
		return this.#keepAgent(rows[0]);
	}

	/** Archives an agent and takes it out of every group; says which groups it left. */
	async archiveAgent(name: string): Promise<AgentGroup[]> {
		const rows: AgentRow[] = await this.#sql`
			UPDATE agents SET status = 'archived', updated_at = now()
			WHERE guild_id = ${this.#guild} AND name = ${name} RETURNING *`;
		this.#keepAgent(rows[0]);
		const left: AgentGroup[] = [];
		for (const group of this.groups()) {
			if (group.status !== "active" || !group.members.includes(name)) continue;
			const members = group.members.filter((m) => m !== name);
			const host = group.host === name ? (members[0] ?? name) : group.host;
			left.push(
				await this.#writeGroup(group.name, {
					members,
					host,
					status: members.length < MIN_GROUP_MEMBERS ? "archived" : "active",
				}),
			);
		}
		return left;
	}

	#keepAgent(row: AgentRow | undefined): Agent {
		if (!row) throw new AgentError("the agent was not found");
		const agent = toAgent(row);
		this.#agents.set(agent.name, agent);
		return agent;
	}

	#checkMembers(members: readonly string[], host: string): void {
		if (
			new Set(members).size !== members.length ||
			members.length < MIN_GROUP_MEMBERS ||
			members.length > MAX_GROUP_MEMBERS
		)
			throw new AgentError(
				`A group has ${MIN_GROUP_MEMBERS} to ${MAX_GROUP_MEMBERS} different members.`,
			);
		for (const member of members) this.activeAgent(member);
		if (!members.includes(host))
			throw new AgentError(`The host "${host}" must be one of the members.`);
	}

	/** Checks a new group before its channel is made. */
	checkNewGroup(name: string, members: readonly string[], host: string): void {
		checkAgentName(name);
		this.#checkFree(name);
		this.#checkMembers(members, host);
	}

	async createGroup(group: {
		name: string;
		displayName: string;
		channelId: string;
		members: string[];
		host: string;
	}): Promise<AgentGroup> {
		this.checkNewGroup(group.name, group.members, group.host);
		checkDisplayName(group.displayName);
		const rows: GroupRow[] = await this.#sql`
			INSERT INTO agent_groups (guild_id, name, display_name, channel_id, members, host)
			VALUES (${this.#guild}, ${group.name}, ${group.displayName.trim()}, ${group.channelId},
				${group.members.join(",")}, ${group.host})
			RETURNING *`;
		return this.#keepGroup(rows[0]);
	}

	async updateGroup(
		name: string,
		change: { displayName?: string; members?: string[]; host?: string },
	): Promise<AgentGroup> {
		const current = this.#groups.get(name);
		if (current?.status !== "active")
			throw new AgentError(`There is no active group "${name}".`);
		if (change.displayName !== undefined) checkDisplayName(change.displayName);
		const members = change.members ?? current.members;
		const host =
			change.host ??
			(members.includes(current.host) ? current.host : (members[0] ?? ""));
		this.#checkMembers(members, host);
		return this.#writeGroup(name, {
			displayName: change.displayName?.trim() ?? current.displayName,
			members,
			host,
			status: "active",
		});
	}

	async archiveGroup(name: string): Promise<AgentGroup> {
		return this.#writeGroup(name, { status: "archived" });
	}

	async #writeGroup(
		name: string,
		change: {
			displayName?: string;
			members?: string[];
			host?: string;
			status?: AgentStatus;
		},
	): Promise<AgentGroup> {
		const current = this.#groups.get(name);
		if (!current) throw new AgentError(`There is no group "${name}".`);
		const rows: GroupRow[] = await this.#sql`
			UPDATE agent_groups SET
				display_name = ${change.displayName ?? current.displayName},
				members = ${(change.members ?? current.members).join(",")},
				host = ${change.host ?? current.host},
				status = ${change.status ?? current.status}
			WHERE guild_id = ${this.#guild} AND name = ${name}
			RETURNING *`;
		return this.#keepGroup(rows[0]);
	}

	#keepGroup(row: GroupRow | undefined): AgentGroup {
		if (!row) throw new AgentError("the group was not found");
		const group = toGroup(row);
		this.#groups.set(group.name, group);
		return group;
	}

	appendGroupMessage(
		group: string,
		message: { author: string; authorName: string; text: string },
	): Promise<number> {
		return this.#messages.append(group, message);
	}

	/** The group's newest messages, oldest first. */
	recentGroupMessages(group: string, limit: number): Promise<GroupMessage[]> {
		return this.#messages.recent(group, limit);
	}

	/** Group messages the member has not received yet, its own excluded; the newest `limit` are carried. */
	backlog(group: string, agent: string, limit: number): Promise<Backlog> {
		return this.#messages.backlog(group, agent, limit);
	}

	advanceCursor(group: string, agent: string, lastId: number): Promise<void> {
		return this.#messages.advanceCursor(group, agent, lastId);
	}

	/** Marks every message so far as received by every member, for a group started over. */
	catchUp(group: AgentGroup): Promise<void> {
		return this.#messages.catchUp(group);
	}
}
