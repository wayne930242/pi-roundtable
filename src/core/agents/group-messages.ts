import type { SQL } from "bun";
import type { AgentGroup, Backlog, GroupMessage } from "./agent-rules.ts";

interface MessageRow {
	id: string | number;
	author: string;
	author_name: string;
	text: string;
	created_at: Date;
}

const toMessage = (row: MessageRow): GroupMessage => ({
	id: Number(row.id),
	author: row.author,
	authorName: row.author_name,
	text: row.text,
	at: row.created_at,
});

/** A guild's group messages and each member's cursor into them. */
export class GroupMessages {
	readonly #sql: SQL;
	readonly #guild: string;

	constructor(sql: SQL, guildId: string) {
		this.#sql = sql;
		this.#guild = guildId;
	}

	async append(
		group: string,
		message: { author: string; authorName: string; text: string },
	): Promise<number> {
		const rows: { id: string | number }[] = await this.#sql`
			INSERT INTO agent_group_messages (guild_id, group_name, author, author_name, text)
			VALUES (${this.#guild}, ${group}, ${message.author}, ${message.authorName}, ${message.text})
			RETURNING id`;
		return Number(rows[0]?.id);
	}

	/** The group's newest messages, oldest first. */
	async recent(group: string, limit: number): Promise<GroupMessage[]> {
		const rows: MessageRow[] = await this.#sql`
			SELECT id, author, author_name, text, created_at FROM agent_group_messages
			WHERE guild_id = ${this.#guild} AND group_name = ${group} ORDER BY id DESC LIMIT ${limit}`;
		return rows.toReversed().map(toMessage);
	}

	/** Group messages the member has not received yet, its own excluded; the newest `limit` are carried. */
	async backlog(group: string, agent: string, limit: number): Promise<Backlog> {
		const cursor = await this.#cursor(group, agent);
		const rows: MessageRow[] = await this.#sql`
			SELECT id, author, author_name, text, created_at FROM agent_group_messages
			WHERE guild_id = ${this.#guild} AND group_name = ${group} AND id > ${cursor}
			ORDER BY id`;
		const waiting = rows.map(toMessage);
		const others = waiting.filter((m) => m.author !== agent);
		const carried = others.slice(-limit);
		return {
			messages: carried,
			skipped: others.length - carried.length,
			lastId: waiting.at(-1)?.id,
		};
	}

	async advanceCursor(
		group: string,
		agent: string,
		lastId: number,
	): Promise<void> {
		await this.#sql`
			INSERT INTO agent_group_cursors (guild_id, group_name, agent_name, last_id)
			VALUES (${this.#guild}, ${group}, ${agent}, ${lastId})
			ON CONFLICT (guild_id, group_name, agent_name)
			DO UPDATE SET last_id = GREATEST(agent_group_cursors.last_id, EXCLUDED.last_id)`;
	}

	/** Marks every message so far as received by every member, for a group started over. */
	async catchUp(group: AgentGroup): Promise<void> {
		const rows: { id: string | number | null }[] = await this.#sql`
			SELECT max(id) AS id FROM agent_group_messages
			WHERE guild_id = ${this.#guild} AND group_name = ${group.name}`;
		const last = rows[0]?.id;
		if (last === null || last === undefined) return;
		for (const member of group.members)
			await this.advanceCursor(group.name, member, Number(last));
	}

	/**
	 * A member's cursor; one that joined late starts at the messages before it joined, so it
	 * catches up on the group's recent history.
	 */
	async #cursor(group: string, agent: string): Promise<number> {
		const rows: { last_id: string | number }[] = await this.#sql`
			SELECT last_id FROM agent_group_cursors
			WHERE guild_id = ${this.#guild} AND group_name = ${group} AND agent_name = ${agent}`;
		return rows[0] ? Number(rows[0].last_id) : 0;
	}
}
