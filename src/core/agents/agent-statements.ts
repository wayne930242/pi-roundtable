import type { SQL } from "bun";
import type { CharacterSpec } from "../../characters/index.ts";
import type { AgentStatus } from "./agent-rules.ts";
import type { AgentRow, GroupRow } from "./agent-schema.ts";

/**
 * The SQL the agent store runs for one guild. The store holds the rows in memory and decides
 * what may change; each method here only writes the statement and returns the rows it touched.
 */
export class AgentStatements {
	readonly #sql: SQL;
	readonly #guild: string;

	constructor(sql: SQL, guildId: string) {
		this.#sql = sql;
		this.#guild = guildId;
	}

	/** Inserts a seed agent unless one of that name exists; no row comes back when one does. */
	insertSeed(seed: {
		name: string;
		displayName: string;
		prompt: string;
		avatarPrompt: string;
		channelId: string | null;
	}): Promise<AgentRow[]> {
		return this.#sql`
				INSERT INTO agents (guild_id, name, display_name, prompt, avatar_prompt, channel_id)
				VALUES (${this.#guild}, ${seed.name}, ${seed.displayName}, ${seed.prompt}, ${seed.avatarPrompt},
					${seed.channelId})
				ON CONFLICT DO NOTHING
				RETURNING *`;
	}

	insertAgent(agent: {
		name: string;
		displayName: string;
		prompt: string;
		avatarPrompt: string;
		channelId: string | null;
		avatarHash: string | null;
		character: CharacterSpec | null;
		/** The knight that made it as a temp knight, which starts out working. */
		parent: string | null;
	}): Promise<AgentRow[]> {
		return this.#sql`
			INSERT INTO agents (guild_id, name, display_name, prompt, avatar_prompt, channel_id, avatar_hash, character, parent)
			VALUES (${this.#guild}, ${agent.name}, ${agent.displayName}, ${agent.prompt}, ${agent.avatarPrompt},
				${agent.channelId}, ${agent.avatarHash},
				${agent.character}::jsonb, ${agent.parent})
			RETURNING *`;
	}

	/** Stamps a temp knight finished at `at`, or clears the stamp with null; a permanent knight is left alone. */
	setFinished(name: string, at: Date | null): Promise<AgentRow[]> {
		return this.#sql`
			UPDATE agents SET finished_at = ${at}
			WHERE guild_id = ${this.#guild} AND name = ${name} AND parent IS NOT NULL
			RETURNING *`;
	}

	/** Writes every column of an agent; `characterSet` false leaves the stored character alone. */
	updateAgent(
		name: string,
		row: {
			displayName: string;
			prompt: string;
			avatarPrompt: string;
			avatarHash: string | null;
			characterSet: boolean;
			character: CharacterSpec | null;
			channelId: string | null;
			model: string | null;
			thinking: string | null;
		},
	): Promise<AgentRow[]> {
		return this.#sql`
			UPDATE agents SET
				display_name = ${row.displayName},
				prompt = ${row.prompt},
				avatar_prompt = ${row.avatarPrompt},
				avatar_hash = ${row.avatarHash},
				character = CASE WHEN ${row.characterSet} THEN ${row.character}::jsonb ELSE character END,
				channel_id = ${row.channelId},
				model = ${row.model},
				thinking = ${row.thinking},
				updated_at = now()
			WHERE guild_id = ${this.#guild} AND name = ${name}
			RETURNING *`;
	}

	archiveAgent(name: string): Promise<AgentRow[]> {
		return this.#sql`
			UPDATE agents SET status = 'archived', updated_at = now()
			WHERE guild_id = ${this.#guild} AND name = ${name} RETURNING *`;
	}

	/** A restored temp knight has nothing running, so it comes back finished. */
	restoreAgent(name: string, channelId: string | null): Promise<AgentRow[]> {
		return this.#sql`
			UPDATE agents SET status = 'active', channel_id = ${channelId},
				finished_at = CASE WHEN parent IS NULL THEN NULL ELSE now() END,
				updated_at = now()
			WHERE guild_id = ${this.#guild} AND name = ${name}
			RETURNING *`;
	}

	/** Deletes the agent's row, its group cursors and its prompt history together. */
	async deleteAgent(name: string): Promise<void> {
		await this.#sql.begin(async (tx) => {
			await tx`DELETE FROM agent_group_cursors WHERE guild_id = ${this.#guild} AND agent_name = ${name}`;
			await tx`DELETE FROM prompt_history WHERE guild_id = ${this.#guild} AND kind = 'agent' AND name = ${name}`;
			await tx`DELETE FROM agents WHERE guild_id = ${this.#guild} AND name = ${name}`;
		});
	}

	/** Gives an agent a character and picture only while it has no character. */
	dressIfUndressed(
		name: string,
		character: CharacterSpec,
		avatarHash: string,
	): Promise<AgentRow[]> {
		return this.#sql`
			UPDATE agents SET character = ${character}::jsonb, avatar_hash = ${avatarHash}, updated_at = now()
			WHERE guild_id = ${this.#guild} AND name = ${name} AND character IS NULL
			RETURNING *`;
	}

	/** Sets the picture only while the agent is active and still wears `character`. */
	setAvatarIfLook(
		name: string,
		character: CharacterSpec,
		avatarHash: string,
	): Promise<AgentRow[]> {
		return this.#sql`
			UPDATE agents SET avatar_hash = ${avatarHash}, updated_at = now()
			WHERE guild_id = ${this.#guild} AND name = ${name} AND status = 'active'
				AND character = ${character}::jsonb
			RETURNING *`;
	}

	insertGroup(group: {
		name: string;
		displayName: string;
		channelId: string | null;
		members: readonly string[];
		host: string;
	}): Promise<GroupRow[]> {
		return this.#sql`
			INSERT INTO agent_groups (guild_id, name, display_name, channel_id, members, host)
			VALUES (${this.#guild}, ${group.name}, ${group.displayName}, ${group.channelId},
				${group.members.join(",")}, ${group.host})
			RETURNING *`;
	}

	updateGroup(
		name: string,
		row: {
			displayName: string;
			members: readonly string[];
			host: string;
			status: AgentStatus;
		},
	): Promise<GroupRow[]> {
		return this.#sql`
			UPDATE agent_groups SET
				display_name = ${row.displayName},
				members = ${row.members.join(",")},
				host = ${row.host},
				status = ${row.status}
			WHERE guild_id = ${this.#guild} AND name = ${name}
			RETURNING *`;
	}

	restoreGroup(name: string, channelId: string | null): Promise<GroupRow[]> {
		return this.#sql`
			UPDATE agent_groups SET status = 'active', channel_id = ${channelId}
			WHERE guild_id = ${this.#guild} AND name = ${name}
			RETURNING *`;
	}

	/** Deletes the group's row, messages and cursors, in the Discord channel's log and each room's. */
	async deleteGroup(name: string): Promise<void> {
		const rooms = `${name}@%`;
		await this.#sql.begin(async (tx) => {
			await tx`DELETE FROM agent_group_cursors WHERE guild_id = ${this.#guild} AND (group_name = ${name} OR group_name LIKE ${rooms})`;
			await tx`DELETE FROM agent_group_messages WHERE guild_id = ${this.#guild} AND (group_name = ${name} OR group_name LIKE ${rooms})`;
			await tx`DELETE FROM agent_groups WHERE guild_id = ${this.#guild} AND name = ${name}`;
		});
	}
}
