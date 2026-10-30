import type { SQL } from "bun";
import type { CharacterSpec } from "../../characters/index.ts";
import type { Migration } from "../db/migrations.ts";
import { AgentError } from "../domain/errors.ts";
import type { ThinkingLevel } from "../models.ts";
import {
	PromptHistory,
	type PromptVersion,
} from "../modules/prompts/prompt-history.ts";
import type { AgentDirectory } from "../services.ts";
import { AgentBook } from "./agent-book.ts";
import { AgentConversations } from "./agent-conversations.ts";
import { AgentOutbox } from "./agent-outbox.ts";
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
	MIN_GROUP_MEMBERS,
} from "./agent-rules.ts";
import {
	type AgentRow,
	agentMigrations,
	agentsMigration,
	type GroupRow,
	toGroup,
} from "./agent-schema.ts";
import { AgentStatements } from "./agent-statements.ts";
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
export class PgAgentStore extends AgentBook implements AgentDirectory {
	readonly #sql: SQL;
	/** The tail of the agent and group writes, which run one at a time so none reads a map another is about to change. */
	#queue: Promise<unknown> = Promise.resolve();

	readonly #guild: string;
	readonly #statements: AgentStatements;
	readonly #messages: GroupMessages;
	readonly #prompts: PromptHistory;
	/** Agent messages the host stopped before delivering them. */
	readonly outbox: AgentOutbox;
	/** The conversation each agent last ran a turn in. */
	readonly conversations: AgentConversations;

	private constructor(
		sql: SQL,
		guildId: string,
		conversations: AgentConversations,
	) {
		super();
		this.conversations = conversations;
		this.#sql = sql;
		this.#guild = guildId;
		this.#statements = new AgentStatements(sql, guildId);
		this.#messages = new GroupMessages(sql, guildId);
		this.#prompts = new PromptHistory(sql, guildId);
		this.outbox = new AgentOutbox(sql, guildId);
	}

	/** The store's tables; the host runs this before any store attaches. */
	static readonly migration: Migration = agentsMigration;

	/** The migrations of the store's tables for the guild the process serves. */
	static migrations(guildId: string): Migration[] {
		return agentMigrations(guildId);
	}

	/** The store over the host's migrated pool, holding the rows of one guild. */
	static async attach(sql: SQL, guildId: string): Promise<PgAgentStore> {
		// `Roundtable.check()` has no database to read the rows from: the store starts empty.
		const checking = isCheckDatabase(sql);
		const store = new PgAgentStore(
			sql,
			guildId,
			checking
				? AgentConversations.memory()
				: await AgentConversations.load(sql, guildId),
		);
		if (!checking) await store.#reload();
		return store;
	}

	async #reload(): Promise<void> {
		const agents: AgentRow[] = await this
			.#sql`SELECT * FROM agents WHERE guild_id = ${this.#guild}`;
		const groups: GroupRow[] = await this
			.#sql`SELECT * FROM agent_groups WHERE guild_id = ${this.#guild}`;
		this.agentMap.clear();
		this.groupMap.clear();
		this.dressed.clear();
		for (const row of agents) this.keepAgentRow(row);
		for (const row of groups) this.groupMap.set(row.name, toGroup(row));
	}

	/** Inserts seed agents that do not exist yet; existing rows, edited or not, are left alone. */
	async seed(seeds: readonly AgentSeed[]): Promise<string[]> {
		return this.#serial(async () => {
			const added: string[] = [];
			for (const seed of seeds) {
				const rows = await this.#statements.insertSeed({
					...seed,
					avatarPrompt: seed.avatarPrompt ?? "",
					channelId: seed.channelId ?? null,
				});
				// Only the inserted rows join the map: reloading it whole would drop a write that
				// committed after its SELECT.
				if (rows[0]) added.push(this.keepAgent(rows[0]).name);
			}
			return added;
		});
	}

	#serial<T>(write: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(write);
		this.#queue = run.catch(() => undefined);
		return run;
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
		/** Makes it a temp knight of this active, permanent knight. */
		parent?: string;
		origin?: string; // the conversation a temp knight was made from
	}): Promise<Agent> {
		return this.#serial(async () => {
			checkAgentName(agent.name);
			if (agent.parent !== undefined) this.checkParent(agent.parent);
			checkDisplayName(agent.displayName);
			checkPrompt(agent.prompt);
			const avatarPrompt = agent.avatarPrompt ?? "";
			if (avatarPrompt !== "") checkAvatarPrompt(avatarPrompt);
			this.checkFree(agent.name);
			const rows = await this.#statements.insertAgent({
				name: agent.name,
				displayName: agent.displayName.trim(),
				prompt: agent.prompt,
				avatarPrompt,
				channelId: agent.channelId ?? null,
				avatarHash: agent.avatarHash ?? null,
				character: agent.character ?? null,
				parent: agent.parent ?? null,
				origin: agent.origin ?? null,
			});
			return this.keepAgent(rows[0]);
		});
	}

	/** Marks an active temp knight finished now, or working again with `false`; says whether the stamp changed. */
	setFinished(name: string, finished: boolean): Promise<boolean> {
		return this.#writeOne(() =>
			this.stampChanges(name, finished)
				? this.#statements.setFinished(name, finished ? new Date() : null)
				: Promise.resolve([]),
		);
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
		/** Who made the change; a changed prompt is kept in the agent's prompt history under this name. */
		by = "unknown",
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
			const row = {
				displayName: change.displayName?.trim() ?? current.displayName,
				prompt: change.prompt ?? current.prompt,
				avatarPrompt: change.avatarPrompt ?? current.avatarPrompt,
				avatarHash: change.avatarHash ?? current.avatarHash ?? null,
				characterSet: change.character !== undefined,
				character: change.character ?? null,
				channelId: change.channelId ?? current.channelId ?? null,
				model,
				thinking,
			};
			const prompt = change.prompt;
			// A new prompt and its history row commit together, so no change goes unrecorded.
			const rows =
				prompt !== undefined && prompt !== current.prompt
					? await this.#sql.begin(async (tx) => {
							const written = await new AgentStatements(
								tx,
								this.#guild,
							).updateAgent(name, row);
							await this.#prompts.record(
								"agent",
								name,
								{ action: "set", text: prompt, previous: current.prompt, by },
								tx,
							);
							return written;
						})
					: await this.#statements.updateAgent(name, row);
			return this.keepAgent(rows[0]);
		});
	}

	/** The changes of an agent's prompt, newest first. */
	promptHistory(name: string, limit?: number): Promise<PromptVersion[]> {
		return this.#prompts.list("agent", name, limit);
	}

	/**
	 * Archives an agent and takes it out of every group; says which groups it left. A group this
	 * would leave with too few members is archived whole, its members kept, so it can be restored
	 * once they are all active again.
	 */
	async archiveAgent(name: string): Promise<AgentGroup[]> {
		return this.#serial(async () => {
			this.keepAgent((await this.#statements.archiveAgent(name))[0]);
			const left: AgentGroup[] = [];
			for (const group of this.groups()) {
				if (group.status !== "active" || !group.members.includes(name))
					continue;
				const members = group.members.filter((m) => m !== name);
				if (members.length < MIN_GROUP_MEMBERS) {
					left.push(await this.#writeGroup(group.name, { status: "archived" }));
					continue;
				}
				const host = group.host === name ? (members[0] ?? name) : group.host;
				left.push(await this.#writeGroup(group.name, { members, host }));
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
			const current = this.agentMap.get(name);
			if (!current) throw new AgentError(`There is no agent "${name}".`);
			if (current.status === "active")
				throw new AgentError(`"${name}" is not archived.`);
			const rows = await this.#statements.restoreAgent(
				name,
				channelId ?? current.channelId ?? null,
			);
			return this.keepAgent(rows[0]);
		});
	}

	/**
	 * Deletes an archived agent, its group cursors and its prompt history, and takes it out of the
	 * archived groups that still list it; its name is free again, and a new agent of that name
	 * starts with an empty history. An active agent is never deleted: archive it first.
	 */
	async deleteAgent(name: string): Promise<void> {
		return this.#serial(async () => {
			const current = this.agentMap.get(name);
			if (!current) throw new AgentError(`There is no agent "${name}".`);
			if (current.status === "active")
				throw new AgentError(
					`"${name}" is active; archive it before deleting it.`,
				);
			await this.#statements.deleteAgent(name);
			this.agentMap.delete(name);
			this.dressed.delete(name);
			// An archived group still lists the agent; a new agent of this name must not join it unasked.
			for (const group of this.groups()) {
				if (!group.members.includes(name)) continue;
				const members = group.members.filter((m) => m !== name);
				await this.#writeGroup(group.name, {
					members,
					host: group.host === name ? (members[0] ?? "") : group.host,
				});
			}
		});
	}

	/**
	 * Stores a character and picture only while the agent still has none, so a look chosen in the
	 * meantime wins. Returns whether it was written.
	 */
	dressIfUndressed(
		name: string,
		character: CharacterSpec,
		avatarHash: string,
	): Promise<boolean> {
		return this.#writeOne(() =>
			this.#statements.dressIfUndressed(name, character, avatarHash),
		);
	}

	/**
	 * Sets the picture only while the agent is active and still wears `character`, inside the
	 * store's write queue, so a look saved meanwhile keeps its own picture. Returns whether it was
	 * written.
	 */
	setAvatarIfLook(
		name: string,
		character: CharacterSpec,
		avatarHash: string,
	): Promise<boolean> {
		return this.#writeOne(() =>
			this.#statements.setAvatarIfLook(name, character, avatarHash),
		);
	}

	/** Runs a conditional row write in the queue; true when it wrote a row, which joins the map. */
	#writeOne(write: () => Promise<AgentRow[]>): Promise<boolean> {
		return this.#serial(async () => {
			const [row] = await write();
			if (row) this.keepAgentRow(row);
			return row !== undefined;
		});
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
			const rows = await this.#statements.insertGroup({
				...group,
				displayName: group.displayName.trim(),
				channelId: group.channelId ?? null,
			});
			return this.keepGroup(rows[0]);
		});
	}

	async updateGroup(
		name: string,
		change: { displayName?: string; members?: string[]; host?: string },
	): Promise<AgentGroup> {
		return this.#serial(async () => {
			const current = this.groupMap.get(name);
			if (current?.status !== "active")
				throw new AgentError(`There is no active group "${name}".`);
			if (change.displayName !== undefined)
				checkDisplayName(change.displayName);
			const members = change.members ?? current.members;
			const host =
				change.host ??
				(members.includes(current.host) ? current.host : (members[0] ?? ""));
			this.checkMembers(members, host);
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

	/**
	 * Returns an archived group to the active ones, on a new channel when its old one is gone. Its
	 * members must all be active still and number enough; otherwise it refuses and stays archived.
	 */
	async restoreGroup(name: string, channelId?: string): Promise<AgentGroup> {
		return this.#serial(async () => {
			const current = this.checkRestorableGroup(name);
			const rows = await this.#statements.restoreGroup(
				name,
				channelId ?? current.channelId ?? null,
			);
			return this.keepGroup(rows[0]);
		});
	}

	/**
	 * Deletes an archived group with its messages and cursors, in the Discord channel's log and in
	 * each room's (`<group>@<surface>`); its name is free again. An active group is never deleted.
	 */
	async deleteGroup(name: string): Promise<void> {
		return this.#serial(async () => {
			const current = this.groupMap.get(name);
			if (!current) throw new AgentError(`There is no group "${name}".`);
			if (current.status === "active")
				throw new AgentError(
					`"${name}" is active; archive it before deleting it.`,
				);
			await this.#statements.deleteGroup(name);
			this.groupMap.delete(name);
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
		const current = this.groupMap.get(name);
		if (!current) throw new AgentError(`There is no group "${name}".`);
		const rows = await this.#statements.updateGroup(name, {
			displayName: change.displayName ?? current.displayName,
			members: change.members ?? current.members,
			host: change.host ?? current.host,
			status: change.status ?? current.status,
		});
		return this.keepGroup(rows[0]);
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
