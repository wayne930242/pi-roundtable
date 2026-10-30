import type { SQL } from "bun";
import type { Migration } from "../db/migrations.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import type { Speaker } from "../speakers.ts";

/**
 * An agent message the host stopped before it could deliver. `message` is the request to the
 * target; `reply` is the follow-up turn that carries the target's answer back to the sender. Each
 * is kept with the chain it belonged to, so the replayed turn counts against the same limit.
 */
export interface OutboxEntry {
	kind: "message" | "reply";
	/** The agent that asked. */
	sender: string;
	/** The agent whose turn the entry starts. */
	target: string;
	/** The target's conversation: where the entry runs and posts. */
	channel: ChannelKey;
	/** What the turn is given: the request, or the sender's follow-up text. */
	text: string;
	/** The surface of the room the exchange runs in; absent in a Discord channel. */
	via?: string;
	speaker: Speaker;
	/** The messages the chain had sent when the entry was stored. */
	messages: number;
}

/** A stored entry and its id, which orders the replay and makes it happen once. */
export interface StoredOutboxEntry extends OutboxEntry {
	id: number;
}

interface OutboxRow {
	id: string | number;
	payload: OutboxEntry | string;
}

/** The table of undelivered agent messages, created after the guild scoping so it carries its guild from the start. */
export const outboxMigration = (): Migration => ({
	name: "agent-outbox",
	up: async (sql) => {
		await sql`
			CREATE TABLE IF NOT EXISTS agent_outbox (
				id bigserial PRIMARY KEY,
				guild_id text NOT NULL,
				channel text NOT NULL,
				payload jsonb NOT NULL,
				created_at timestamptz NOT NULL DEFAULT now()
			)`;
		await sql`CREATE INDEX IF NOT EXISTS agent_outbox_guild ON agent_outbox (guild_id, id)`;
	},
});

/**
 * Agent messages and follow-ups the host refused while it stopped, kept for the next start.
 * A row is removed by whoever claims it, so two hosts replaying the same table deliver each once.
 */
export class AgentOutbox {
	readonly #sql: SQL;
	readonly #guild: string;

	constructor(sql: SQL, guildId: string) {
		this.#sql = sql;
		this.#guild = guildId;
	}

	async keep(entry: OutboxEntry): Promise<void> {
		await this.#sql`
			INSERT INTO agent_outbox (guild_id, channel, payload)
			VALUES (${this.#guild}, ${entry.channel}, ${JSON.stringify(entry)}::jsonb)`;
	}

	/** Every kept entry, oldest first. */
	async pending(): Promise<StoredOutboxEntry[]> {
		const rows: OutboxRow[] = await this.#sql`
			SELECT id, payload FROM agent_outbox WHERE guild_id = ${this.#guild} ORDER BY id`;
		return rows.map((row) => ({
			...(typeof row.payload === "string"
				? (JSON.parse(row.payload) as OutboxEntry)
				: row.payload),
			id: Number(row.id),
		}));
	}

	/** Takes the entry out; false when another host or an earlier call already did. */
	async claim(id: number): Promise<boolean> {
		const rows: { id: string | number }[] = await this.#sql`
			DELETE FROM agent_outbox WHERE guild_id = ${this.#guild} AND id = ${id} RETURNING id`;
		return rows.length > 0;
	}
}
