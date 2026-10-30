import type { SQL } from "bun";
import type { ChannelKey } from "../domain/conversation.ts";

interface Row {
	agent_name: string;
	channel_key: ChannelKey;
}

/**
 * The conversation each agent last ran a turn in, kept in the database so a message to an agent
 * still lands where it was working after the host restarts. The map answers the reads; a write
 * goes to it at once and to the table behind it. Without a database it is the map alone.
 */
export class AgentConversations {
	readonly #sql: SQL | undefined;
	readonly #guild: string;
	readonly #latest = new Map<string, ChannelKey>();
	/** The tail of the writes, so the table ends with the last conversation noted. */
	#tail: Promise<unknown> = Promise.resolve();

	private constructor(sql: SQL | undefined, guildId: string) {
		this.#sql = sql;
		this.#guild = guildId;
	}

	/** The table, created by the agents' migrations. */
	static readonly migration = {
		name: "agent-latest-conversation",
		up: async (sql: SQL) => {
			await sql`
				CREATE TABLE IF NOT EXISTS agent_latest_conversation (
					guild_id text NOT NULL,
					agent_name text NOT NULL,
					channel_key text NOT NULL,
					active_at timestamptz NOT NULL DEFAULT now(),
					PRIMARY KEY (guild_id, agent_name)
				)`;
		},
	};

	/** The guild's rows, read from the table. */
	static async load(sql: SQL, guildId: string): Promise<AgentConversations> {
		const log = new AgentConversations(sql, guildId);
		const rows: Row[] = await sql`
			SELECT agent_name, channel_key FROM agent_latest_conversation
			WHERE guild_id = ${guildId}`;
		for (const row of rows) log.#latest.set(row.agent_name, row.channel_key);
		return log;
	}

	/** An empty log that writes nowhere, for a host with no database to read. */
	static memory(): AgentConversations {
		return new AgentConversations(undefined, "");
	}

	/** The conversation the agent last ran a turn in. */
	latest(agent: string): ChannelKey | undefined {
		return this.#latest.get(agent);
	}

	/** Records the conversation the agent's turn runs in; resolves once it is written, and rejects if the write fails. */
	note(agent: string, channel: ChannelKey): Promise<void> {
		if (this.#latest.get(agent) === channel) return Promise.resolve();
		this.#latest.set(agent, channel);
		const sql = this.#sql;
		if (!sql) return Promise.resolve();
		const write = this.#tail.then(
			() => sql`
				INSERT INTO agent_latest_conversation (guild_id, agent_name, channel_key)
				VALUES (${this.#guild}, ${agent}, ${channel})
				ON CONFLICT (guild_id, agent_name)
				DO UPDATE SET channel_key = ${channel}, active_at = now()`,
		);
		this.#tail = write.catch(() => undefined);
		return write.then(() => undefined);
	}
}
