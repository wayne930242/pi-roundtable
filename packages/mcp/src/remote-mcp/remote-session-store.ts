import { randomUUID } from "node:crypto";
import type { SQL } from "bun";
import type { Migration } from "pi-roundtable";

/** The conversations outside agents opened with the owner's agent, so they survive a restart. */
export class RemoteSessionStore {
	readonly #sql: SQL;

	private constructor(sql: SQL) {
		this.#sql = sql;
	}

	/** The store's tables; the host runs this before any store attaches. */
	static readonly migration: Migration = {
		name: "remote-sessions",
		up: async (sql) => {
			await sql`
				CREATE TABLE IF NOT EXISTS remote_agent_sessions (
					id uuid PRIMARY KEY,
					created_at timestamptz NOT NULL DEFAULT now(),
					last_used_at timestamptz NOT NULL DEFAULT now()
				)`;
		},
	};

	/** The store over the host's migrated pool. */
	static async attach(sql: SQL): Promise<RemoteSessionStore> {
		return new RemoteSessionStore(sql);
	}

	async create(): Promise<string> {
		const id = randomUUID();
		await this.#sql`INSERT INTO remote_agent_sessions (id) VALUES (${id})`;
		return id;
	}

	/** Marks the session used; resolves false when it does not exist. */
	async touch(id: string): Promise<boolean> {
		const rows = await this.#sql`
			UPDATE remote_agent_sessions SET last_used_at = now() WHERE id = ${id} RETURNING id`;
		return rows.length > 0;
	}

	/** Ends the session, so continuing it answers SESSION_NOT_FOUND. */
	async remove(id: string): Promise<void> {
		await this.#sql`DELETE FROM remote_agent_sessions WHERE id = ${id}`;
	}

	/** Sessions last used before the cutoff. */
	async idleSince(cutoff: Date): Promise<string[]> {
		const rows: { id: string }[] = await this.#sql`
			SELECT id FROM remote_agent_sessions WHERE last_used_at < ${cutoff} ORDER BY last_used_at`;
		return rows.map((row) => row.id);
	}
}
