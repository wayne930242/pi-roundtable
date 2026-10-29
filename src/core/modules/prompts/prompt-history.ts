import type { SQL } from "bun";
import type { Migration } from "../../db/migrations.ts";

/** What a history belongs to: a prompt document, or the prompt of one agent. */
export type PromptKind = "document" | "agent";

/** `set` put new text in force; `revert` took a document back to its file version. */
export type PromptAction = "set" | "revert";

/** One change of a prompt, as it was made. */
export interface PromptVersion {
	id: number;
	action: PromptAction;
	/** The text in force after the change; for a revert, the file version it went back to. */
	text: string;
	/** The text the change replaced. */
	previous: string;
	/** Who made it: the owner's name, or the agent that edited another agent's prompt. */
	by: string;
	at: Date;
}

/** The newest versions a prompt keeps; older ones are dropped as new ones come. */
export const PROMPT_HISTORY_KEEP = 200;

interface HistoryRow {
	id: string | number;
	action: PromptAction;
	text: string;
	previous: string;
	by_name: string;
	at: Date;
}

/** The history table, shared by the documents and the agents; both create it, whichever comes first. */
export const promptHistoryMigration = (name: string): Migration => ({
	name,
	up: async (sql) => {
		await sql`
			CREATE TABLE IF NOT EXISTS prompt_history (
				id bigserial PRIMARY KEY,
				guild_id text NOT NULL,
				kind text NOT NULL,
				name text NOT NULL,
				action text NOT NULL,
				text text NOT NULL,
				previous text NOT NULL,
				by_name text NOT NULL,
				at timestamptz NOT NULL DEFAULT now()
			)`;
		await sql`CREATE INDEX IF NOT EXISTS prompt_history_of ON prompt_history (guild_id, kind, name, id)`;
	},
});

/** Every change of a prompt, in the database, newest first. */
export class PromptHistory {
	readonly #sql: SQL;
	readonly #guild: string;

	constructor(sql: SQL, guildId: string) {
		this.#sql = sql;
		this.#guild = guildId;
	}

	/** Writes one version; `db` is a transaction when the change itself is written in one. */
	async record(
		kind: PromptKind,
		name: string,
		entry: Omit<PromptVersion, "id" | "at">,
		db: SQL = this.#sql,
	): Promise<void> {
		await db`
			INSERT INTO prompt_history (guild_id, kind, name, action, text, previous, by_name)
			VALUES (${this.#guild}, ${kind}, ${name}, ${entry.action}, ${entry.text}, ${entry.previous}, ${entry.by})`;
		await db`
			DELETE FROM prompt_history
			WHERE guild_id = ${this.#guild} AND kind = ${kind} AND name = ${name}
				AND id NOT IN (
					SELECT id FROM prompt_history
					WHERE guild_id = ${this.#guild} AND kind = ${kind} AND name = ${name}
					ORDER BY id DESC LIMIT ${PROMPT_HISTORY_KEEP})`;
	}

	/** The newest versions first. */
	async list(
		kind: PromptKind,
		name: string,
		limit = PROMPT_HISTORY_KEEP,
	): Promise<PromptVersion[]> {
		const rows: HistoryRow[] = await this.#sql`
			SELECT id, action, text, previous, by_name, at FROM prompt_history
			WHERE guild_id = ${this.#guild} AND kind = ${kind} AND name = ${name}
			ORDER BY id DESC LIMIT ${Math.min(Math.max(1, limit), PROMPT_HISTORY_KEEP)}`;
		return rows.map((row) => ({
			id: Number(row.id),
			action: row.action,
			text: row.text,
			previous: row.previous,
			by: row.by_name,
			at: new Date(row.at),
		}));
	}
}
