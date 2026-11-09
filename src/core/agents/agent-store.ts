import type { SQL } from "bun";
import type { CharacterSpec } from "../../characters/index.ts";
import { isCheckDatabase } from "../db/check-database.ts";
import type { Migration } from "../db/migrations.ts";
import { AgentError } from "../domain/errors.ts";
import type { ThinkingLevel } from "../domain/models.ts";
import {
	PromptHistory,
	type PromptVersion,
} from "../modules/prompts/prompt-history.ts";
import type { AgentDirectory } from "../plugin-api/services.ts";
import { AgentConversations } from "./agent-conversations.ts";
import { AgentGroupStore } from "./agent-group-store.ts";
import { AgentOutbox } from "./agent-outbox.ts";
import { AgentPlaces } from "./agent-places.ts";
import {
	type Agent,
	type AgentGroup,
	type AgentSeed,
	checkAgentName,
	checkAvatarPrompt,
	checkDisplayName,
	checkModelRef,
	checkPrompt,
	checkThinking,
	MIN_GROUP_MEMBERS,
} from "./agent-rules.ts";
import {
	type AgentRow,
	agentMigrations,
	agentPlacesConvergence,
	agentsMigration,
	type GroupRow,
	toGroup,
} from "./agent-schema.ts";
import { HelperPresets } from "./helper-presets.ts";

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
export class PgAgentStore extends AgentGroupStore implements AgentDirectory {
	readonly #prompts: PromptHistory;
	/** Agent messages the host stopped before delivering them. */
	readonly outbox: AgentOutbox;
	/** The conversation each agent last ran a turn in. */
	readonly conversations: AgentConversations;
	/** The temp-knight presets each agent saved. */
	readonly presets: HelperPresets;

	private constructor(
		sql: SQL,
		teamId: string,
		conversations: AgentConversations,
		places: AgentPlaces,
	) {
		super(sql, teamId, places);
		this.conversations = conversations;
		this.#prompts = new PromptHistory(sql, teamId);
		this.outbox = new AgentOutbox(sql, teamId);
		this.presets = new HelperPresets(sql, teamId);
	}

	/** The store's tables; the host runs this before any store attaches. */
	static readonly migration: Migration = agentsMigration;

	/** The migrations of the store's tables for the team the process serves. */
	static migrations(teamId: string): Migration[] {
		return agentMigrations(teamId);
	}

	/** The every-boot migration that makes the place table follow the channel columns; it runs after the team move. */
	static placesConvergence(teamId: string): Migration {
		return agentPlacesConvergence(teamId);
	}

	/** The store over the host's migrated pool, holding the rows of one team. */
	static async attach(sql: SQL, teamId: string): Promise<PgAgentStore> {
		// `Roundtable.check()` has no database to read the rows from: the store starts empty.
		const checking = isCheckDatabase(sql);
		const store = new PgAgentStore(
			sql,
			teamId,
			checking
				? AgentConversations.memory()
				: await AgentConversations.load(sql, teamId),
			checking
				? AgentPlaces.empty(sql, teamId)
				: await AgentPlaces.load(sql, teamId),
		);
		if (!checking) await store.#reload();
		return store;
	}

	async #reload(): Promise<void> {
		const agents: AgentRow[] = await this
			.sql`SELECT * FROM agents WHERE guild_id = ${this.teamId}`;
		const groups: GroupRow[] = await this
			.sql`SELECT * FROM agent_groups WHERE guild_id = ${this.teamId}`;
		this.agentMap.clear();
		this.groupMap.clear();
		this.dressed.clear();
		for (const row of agents) this.keepAgentRow(row);
		for (const row of groups) this.groupMap.set(row.name, toGroup(row));
	}

	/** Inserts seed agents that do not exist yet; existing rows, edited or not, are left alone. */
	async seed(seeds: readonly AgentSeed[]): Promise<string[]> {
		return this.serial(async () => {
			const added: string[] = [];
			for (const seed of seeds) {
				const rows = await this.places.legacy("agent", (tx) =>
					this.statementsOn(tx).insertSeed({
						...seed,
						avatarPrompt: seed.avatarPrompt ?? "",
						channelId: seed.channelId ?? null,
					}),
				);
				// Only inserted rows join the map: a whole reload drops a write committed after its SELECT.
				if (rows[0]) added.push(this.keepAgent(rows[0]).name);
			}
			return added;
		});
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
		preset?: string; // the preset it was made from
	}): Promise<Agent> {
		return this.serial(async () => {
			checkAgentName(agent.name);
			if (agent.parent !== undefined) this.checkParent(agent.parent);
			checkDisplayName(agent.displayName);
			checkPrompt(agent.prompt);
			const avatarPrompt = agent.avatarPrompt ?? "";
			if (avatarPrompt !== "") checkAvatarPrompt(avatarPrompt);
			this.checkFree(agent.name);
			const rows = await this.places.legacy("agent", (tx) =>
				this.statementsOn(tx).insertAgent({
					name: agent.name,
					displayName: agent.displayName.trim(),
					prompt: agent.prompt,
					avatarPrompt,
					channelId: agent.channelId ?? null,
					avatarHash: agent.avatarHash ?? null,
					character: agent.character ?? null,
					parent: agent.parent ?? null,
					origin: agent.origin ?? null,
					preset: agent.preset ?? null,
				}),
			);
			return this.keepAgent(rows[0]);
		});
	}

	/** Marks an active temp knight finished now, or working again with `false`; says whether the stamp changed. */
	setFinished(name: string, finished: boolean): Promise<boolean> {
		return this.#writeOne(() =>
			this.stampChanges(name, finished)
				? this.statements.setFinished(name, finished ? new Date() : null)
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
		return this.serial(async () => {
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
			const rows = await this.places.legacy("agent", async (tx) => {
				const written = await this.statementsOn(tx).updateAgent(name, row);
				if (prompt !== undefined && prompt !== current.prompt)
					await this.#prompts.record(
						"agent",
						name,
						{ action: "set", text: prompt, previous: current.prompt, by },
						tx,
					);
				return written;
			});
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
		return this.serial(async () => {
			this.keepAgent((await this.statements.archiveAgent(name))[0]);
			const left: AgentGroup[] = [];
			for (const group of this.groups()) {
				if (group.status !== "active" || !group.members.includes(name))
					continue;
				const members = group.members.filter((m) => m !== name);
				if (members.length < MIN_GROUP_MEMBERS) {
					left.push(await this.writeGroup(group.name, { status: "archived" }));
					continue;
				}
				const host = group.host === name ? (members[0] ?? name) : group.host;
				left.push(await this.writeGroup(group.name, { members, host }));
			}
			return left;
		});
	}

	/**
	 * Returns an archived agent to the active ones, on a new channel when its old one is gone. It
	 * does not rejoin the groups it left.
	 */
	async restoreAgent(name: string, channelId?: string): Promise<Agent> {
		return this.serial(async () => {
			const current = this.agentMap.get(name);
			if (!current) throw new AgentError(`There is no agent "${name}".`);
			if (current.status === "active")
				throw new AgentError(`"${name}" is not archived.`);
			const rows = await this.places.legacy("agent", (tx) =>
				this.statementsOn(tx).restoreAgent(
					name,
					channelId ?? current.channelId ?? null,
				),
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
		return this.serial(async () => {
			const current = this.agentMap.get(name);
			if (!current) throw new AgentError(`There is no agent "${name}".`);
			if (current.status === "active")
				throw new AgentError(
					`"${name}" is active; archive it before deleting it.`,
				);
			await this.places.dropping("agent", name, (tx) =>
				this.statementsOn(tx).deleteAgent(name),
			);
			this.agentMap.delete(name);
			this.dressed.delete(name);
			// An archived group still lists the agent; a new agent of this name must not join it unasked.
			for (const group of this.groups()) {
				if (!group.members.includes(name)) continue;
				const members = group.members.filter((m) => m !== name);
				await this.writeGroup(group.name, {
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
			this.statements.dressIfUndressed(name, character, avatarHash),
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
			this.statements.setAvatarIfLook(name, character, avatarHash),
		);
	}

	/** Runs a conditional row write in the queue; true when it wrote a row, which joins the map. */
	#writeOne(write: () => Promise<AgentRow[]>): Promise<boolean> {
		return this.serial(async () => {
			const [row] = await write();
			if (row) this.keepAgentRow(row);
			return row !== undefined;
		});
	}
}
