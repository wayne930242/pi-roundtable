import type { SQL } from "bun";
import type { CharacterSpec } from "../../characters/index.ts";
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

import { isCheckDatabase } from "../db/check-database.ts";

/**
 * Agents, groups, and group messages, in the database. Agents and groups are also held
 * in memory, because every inbound message asks and only this process changes them.
 */
export class PgAgentStore implements AgentDirectory {
	readonly #sql: SQL;
	readonly #agents = new Map<string, Agent>();
	/** Agents whose character column holds a value, readable or not. */
	readonly #dressed = new Set<string>();
	readonly #groups = new Map<string, AgentGroup>();
	/** The tail of the agent and group writes, which run one at a time so none reads a map another is about to change. */
	#queue: Promise<unknown> = Promise.resolve();

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
		// `Roundtable.check()` has no database to read the rows from: the store starts empty.
		if (!isCheckDatabase(sql)) await store.#reload();
		return store;
	}

	async #reload(): Promise<void> {
		const agents: AgentRow[] = await this
			.#sql`SELECT * FROM agents WHERE guild_id = ${this.#guild}`;
		const groups: GroupRow[] = await this
			.#sql`SELECT * FROM agent_groups WHERE guild_id = ${this.#guild}`;
		this.#agents.clear();
		this.#groups.clear();
		this.#dressed.clear();
		for (const row of agents) this.#keepAgentRow(row);
		for (const row of groups) this.#groups.set(row.name, toGroup(row));
	}

	/** Inserts seed agents that do not exist yet; existing rows, edited or not, are left alone. */
	async seed(seeds: readonly AgentSeed[]): Promise<string[]> {
		return this.#serial(async () => {
			const added: string[] = [];
			for (const seed of seeds) {
				const rows: AgentRow[] = await this.#sql`
				INSERT INTO agents (guild_id, name, display_name, prompt, avatar_prompt, channel_id)
				VALUES (${this.#guild}, ${seed.name}, ${seed.displayName}, ${seed.prompt}, ${seed.avatarPrompt ?? ""},
					${seed.channelId ?? null})
				ON CONFLICT DO NOTHING
				RETURNING *`;
				// Only the inserted rows join the map: reloading it whole would drop a write that
				// committed after its SELECT.
				if (rows[0]) added.push(this.#keepAgent(rows[0]).name);
			}
			return added;
		});
	}

	#serial<T>(write: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(write);
		this.#queue = run.catch(() => undefined);
		return run;
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
				.flatMap((a) => (a.status === "active" ? [a.name] : []))
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
		/** @deprecated Ignored by the team; kept for a store written by an older host. */
		avatarPrompt?: string;
		character?: CharacterSpec;
		avatarHash?: string;
		/** Absent in a team without Discord, whose agents live in rooms. */
		channelId?: string;
	}): Promise<Agent> {
		return this.#serial(async () => {
			checkAgentName(agent.name);
			checkDisplayName(agent.displayName);
			checkPrompt(agent.prompt);
			const avatarPrompt = agent.avatarPrompt ?? "";
			if (avatarPrompt !== "") checkAvatarPrompt(avatarPrompt);
			this.#checkFree(agent.name);
			const rows: AgentRow[] = await this.#sql`
			INSERT INTO agents (guild_id, name, display_name, prompt, avatar_prompt, channel_id, avatar_hash, character)
			VALUES (${this.#guild}, ${agent.name}, ${agent.displayName.trim()}, ${agent.prompt}, ${avatarPrompt},
				${agent.channelId ?? null}, ${agent.avatarHash ?? null},
				${agent.character ?? null}::jsonb)
			RETURNING *`;
			return this.#keepAgent(rows[0]);
		});
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
			character?: CharacterSpec;
			channelId?: string;
			/** `null` returns it to the assistant's. */
			model?: string | null;
			thinking?: ThinkingLevel | null;
		},
	): Promise<Agent> {
		return this.#serial(async () => {
			const current = this.activeAgent(name);
			if (change.displayName !== undefined)
				checkDisplayName(change.displayName);
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
				character = CASE WHEN ${change.character !== undefined} THEN ${change.character ?? null}::jsonb ELSE character END,
				channel_id = ${change.channelId ?? current.channelId ?? null},
				model = ${model},
				thinking = ${thinking},
				updated_at = now()
			WHERE guild_id = ${this.#guild} AND name = ${name}
			RETURNING *`;
			return this.#keepAgent(rows[0]);
		});
	}

	/** Archives an agent and takes it out of every group; says which groups it left. */
	async archiveAgent(name: string): Promise<AgentGroup[]> {
		return this.#serial(async () => {
			const rows: AgentRow[] = await this.#sql`
			UPDATE agents SET status = 'archived', updated_at = now()
			WHERE guild_id = ${this.#guild} AND name = ${name} RETURNING *`;
			this.#keepAgent(rows[0]);
			const left: AgentGroup[] = [];
			for (const group of this.groups()) {
				if (group.status !== "active" || !group.members.includes(name))
					continue;
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
		});
	}

	/**
	 * Returns an archived agent to the active ones, on a new channel when its old one is gone. It
	 * does not rejoin the groups it left.
	 */
	async restoreAgent(name: string, channelId?: string): Promise<Agent> {
		return this.#serial(async () => {
			const current = this.#agents.get(name);
			if (!current) throw new AgentError(`There is no agent "${name}".`);
			if (current.status === "active")
				throw new AgentError(`"${name}" is not archived.`);
			const rows: AgentRow[] = await this.#sql`
			UPDATE agents SET status = 'active', channel_id = ${channelId ?? current.channelId ?? null},
				updated_at = now()
			WHERE guild_id = ${this.#guild} AND name = ${name}
			RETURNING *`;
			return this.#keepAgent(rows[0]);
		});
	}

	/**
	 * Deletes an archived agent and its group cursors; its name is free again. An active agent is
	 * never deleted: archive it first.
	 */
	async deleteAgent(name: string): Promise<void> {
		return this.#serial(async () => {
			const current = this.#agents.get(name);
			if (!current) throw new AgentError(`There is no agent "${name}".`);
			if (current.status === "active")
				throw new AgentError(
					`"${name}" is active; archive it before deleting it.`,
				);
			await this.#sql.begin(async (tx) => {
				await tx`DELETE FROM agent_group_cursors WHERE guild_id = ${this.#guild} AND agent_name = ${name}`;
				await tx`DELETE FROM agents WHERE guild_id = ${this.#guild} AND name = ${name}`;
			});
			this.#agents.delete(name);
			this.#dressed.delete(name);
		});
	}

	#keepAgent(row: AgentRow | undefined): Agent {
		if (!row) throw new AgentError("the agent was not found");
		return this.#keepAgentRow(row);
	}

	#keepAgentRow(row: AgentRow): Agent {
		const agent = toAgent(row);
		this.#agents.set(agent.name, agent);
		if (row.character !== null && row.character !== undefined)
			this.#dressed.add(agent.name);
		else this.#dressed.delete(agent.name);
		return agent;
	}

	/** Whether the stored column holds a character, even one this version cannot read. */
	hasStoredCharacter(name: string): boolean {
		return this.#dressed.has(name);
	}

	/**
	 * Stores a character and picture only while the agent still has none, so a look chosen in the
	 * meantime wins. Returns whether it was written.
	 */
	async dressIfUndressed(
		name: string,
		character: CharacterSpec,
		avatarHash: string,
	): Promise<boolean> {
		return this.#serial(async () => {
			const rows: AgentRow[] = await this.#sql`
			UPDATE agents SET character = ${character}::jsonb, avatar_hash = ${avatarHash}, updated_at = now()
			WHERE guild_id = ${this.#guild} AND name = ${name} AND character IS NULL
			RETURNING *`;
			if (!rows[0]) return false;
			this.#keepAgentRow(rows[0]);
			return true;
		});
	}

	/**
	 * Sets the picture only while the agent is active and still wears `character`, inside the
	 * store's write queue, so a look saved meanwhile keeps its own picture. Returns whether it was
	 * written.
	 */
	async setAvatarIfLook(
		name: string,
		character: CharacterSpec,
		avatarHash: string,
	): Promise<boolean> {
		return this.#serial(async () => {
			const rows: AgentRow[] = await this.#sql`
			UPDATE agents SET avatar_hash = ${avatarHash}, updated_at = now()
			WHERE guild_id = ${this.#guild} AND name = ${name} AND status = 'active'
				AND character = ${character}::jsonb
			RETURNING *`;
			if (!rows[0]) return false;
			this.#keepAgentRow(rows[0]);
			return true;
		});
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
		/** Absent in a team without Discord, whose groups live in rooms. */
		channelId?: string;
		members: string[];
		host: string;
	}): Promise<AgentGroup> {
		return this.#serial(async () => {
			this.checkNewGroup(group.name, group.members, group.host);
			checkDisplayName(group.displayName);
			const rows: GroupRow[] = await this.#sql`
			INSERT INTO agent_groups (guild_id, name, display_name, channel_id, members, host)
			VALUES (${this.#guild}, ${group.name}, ${group.displayName.trim()}, ${group.channelId ?? null},
				${group.members.join(",")}, ${group.host})
			RETURNING *`;
			return this.#keepGroup(rows[0]);
		});
	}

	async updateGroup(
		name: string,
		change: { displayName?: string; members?: string[]; host?: string },
	): Promise<AgentGroup> {
		return this.#serial(async () => {
			const current = this.#groups.get(name);
			if (current?.status !== "active")
				throw new AgentError(`There is no active group "${name}".`);
			if (change.displayName !== undefined)
				checkDisplayName(change.displayName);
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
		});
	}

	async archiveGroup(name: string): Promise<AgentGroup> {
		return this.#serial(() => this.#writeGroup(name, { status: "archived" }));
	}

	/** The archived group, when it could be restored now; otherwise the error that says why not. */
	checkRestorableGroup(name: string): AgentGroup {
		const current = this.#groups.get(name);
		if (!current) throw new AgentError(`There is no group "${name}".`);
		if (current.status === "active")
			throw new AgentError(`"${name}" is not archived.`);
		this.#checkMembers(current.members, current.host);
		return current;
	}

	/**
	 * Returns an archived group to the active ones, on a new channel when its old one is gone. Its
	 * members must all be active still and number enough; otherwise it refuses and stays archived.
	 */
	async restoreGroup(name: string, channelId?: string): Promise<AgentGroup> {
		return this.#serial(async () => {
			const current = this.checkRestorableGroup(name);
			const rows: GroupRow[] = await this.#sql`
			UPDATE agent_groups SET status = 'active', channel_id = ${channelId ?? current.channelId ?? null}
			WHERE guild_id = ${this.#guild} AND name = ${name}
			RETURNING *`;
			return this.#keepGroup(rows[0]);
		});
	}

	/**
	 * Deletes an archived group with its messages and cursors, in the Discord channel's log and in
	 * each room's (`<group>@<surface>`); its name is free again. An active group is never deleted.
	 */
	async deleteGroup(name: string): Promise<void> {
		return this.#serial(async () => {
			const current = this.#groups.get(name);
			if (!current) throw new AgentError(`There is no group "${name}".`);
			if (current.status === "active")
				throw new AgentError(
					`"${name}" is active; archive it before deleting it.`,
				);
			const rooms = `${name}@%`;
			await this.#sql.begin(async (tx) => {
				await tx`DELETE FROM agent_group_cursors WHERE guild_id = ${this.#guild} AND (group_name = ${name} OR group_name LIKE ${rooms})`;
				await tx`DELETE FROM agent_group_messages WHERE guild_id = ${this.#guild} AND (group_name = ${name} OR group_name LIKE ${rooms})`;
				await tx`DELETE FROM agent_groups WHERE guild_id = ${this.#guild} AND name = ${name}`;
			});
			this.#groups.delete(name);
		});
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
	catchUp(group: AgentGroup, log?: string): Promise<void> {
		return this.#messages.catchUp(group, log);
	}
}
