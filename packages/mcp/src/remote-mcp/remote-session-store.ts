import { randomUUID } from "node:crypto";
import type { SQL } from "bun";
import type { Migration } from "pi-roundtable";

/**
 * The conversations outside agents opened with the agent, each the principal's the dispatch token
 * stood for when it was opened, so they survive a restart and stay theirs.
 */
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

	/** Whose each session is: null for one 0.8 opened, which `adopt` gives the primary owner. */
	static readonly principalMigration: Migration = {
		name: "remote-sessions-principal",
		up: async (sql) => {
			await sql`ALTER TABLE remote_agent_sessions ADD COLUMN IF NOT EXISTS principal_id text`;
		},
	};

	/** Both, in order: what a pool needs before the store attaches. */
	static migrations(): Migration[] {
		return [
			RemoteSessionStore.migration,
			RemoteSessionStore.principalMigration,
		];
	}

	/** The store over the host's migrated pool. */
	static async attach(sql: SQL): Promise<RemoteSessionStore> {
		return new RemoteSessionStore(sql);
	}

	/**
	 * Gives the sessions of no principal, which 0.8 opened for the owner, to the primary owner,
	 * calling `handOver` with each one's id before it commits: a `handOver` that throws leaves them
	 * all unowned for the next start to hand over again. Resolves the ids handed over.
	 */
	async adopt(
		principalId: string,
		handOver: (id: string) => Promise<void>,
	): Promise<string[]> {
		return this.#sql.begin(async (tx) => {
			// The row locks make a start racing this one wait, then find none left to hand over.
			const rows: { id: string }[] = await tx`
				UPDATE remote_agent_sessions SET principal_id = ${principalId}
				WHERE principal_id IS NULL RETURNING id`;
			for (const { id } of rows) await handOver(id);
			return rows.map((row) => row.id);
		});
	}

	/** Every session that is someone's, with whose it is. */
	async owned(): Promise<{ id: string; principalId: string }[]> {
		return this.#sql`
			SELECT id, principal_id AS "principalId" FROM remote_agent_sessions
			WHERE principal_id IS NOT NULL ORDER BY id`;
	}

	async create(principalId: string): Promise<string> {
		const id = randomUUID();
		await this.#sql`
			INSERT INTO remote_agent_sessions (id, principal_id) VALUES (${id}, ${principalId})`;
		return id;
	}

	/** Marks the principal's session used; resolves false when they have no such session. */
	async touch(id: string, principalId: string): Promise<boolean> {
		const rows = await this.#sql`
			UPDATE remote_agent_sessions SET last_used_at = now()
			WHERE id = ${id} AND principal_id = ${principalId}
			RETURNING id`;
		return rows.length > 0;
	}

	/** Ends the session, so continuing it answers SESSION_NOT_FOUND. */
	async remove(id: string): Promise<void> {
		await this.#sql`DELETE FROM remote_agent_sessions WHERE id = ${id}`;
	}

	/** Sessions last used before the cutoff, whoever's they are. */
	async idleSince(cutoff: Date): Promise<string[]> {
		const rows: { id: string }[] = await this.#sql`
			SELECT id FROM remote_agent_sessions WHERE last_used_at < ${cutoff} ORDER BY last_used_at`;
		return rows.map((row) => row.id);
	}
}
