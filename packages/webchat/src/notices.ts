import type { SQL } from "bun";
import type { Migration } from "pi-roundtable";

/** A private inbox entry, independent of conversation transcripts. */
export interface Notice {
	id: string;
	text: string;
	createdAt: string;
	readAt: string | null;
}

interface Row {
	id: string;
	text: string;
	created_at: Date;
	read_at: Date | null;
}

const noticeOf = (row: Row): Notice => ({
	id: row.id,
	text: row.text,
	createdAt: row.created_at.toISOString(),
	readAt: row.read_at?.toISOString() ?? null,
});

/** Notices scoped by principal in every query, including marking one read. */
export class PgNotices {
	readonly #sql: SQL;

	constructor(sql: SQL) {
		this.#sql = sql;
	}

	static readonly migration: Migration = {
		name: "notices",
		up: async (sql) => {
			await sql`CREATE TABLE IF NOT EXISTS webchat_notices (
				principal_id TEXT NOT NULL, id UUID PRIMARY KEY, text TEXT NOT NULL,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), read_at TIMESTAMPTZ
			)`;
			await sql`CREATE INDEX IF NOT EXISTS webchat_notices_principal_created
				ON webchat_notices (principal_id, created_at DESC, id)`;
		},
	};

	async add(principalId: string, text: string): Promise<Notice> {
		const rows: Row[] = await this
			.#sql`INSERT INTO webchat_notices (principal_id, id, text)
			VALUES (${principalId}, ${crypto.randomUUID()}, ${text}) RETURNING *`;
		if (!rows[0]) throw new Error("webchat notice insert returned no row");
		return noticeOf(rows[0]);
	}

	/** Latest entries, with a bounded page; before is the last id of the previous page. */
	async list(
		principalId: string,
		limit = 50,
		before?: string,
	): Promise<Notice[]> {
		const rows: Row[] = before
			? await this
					.#sql`SELECT id, text, created_at, read_at FROM webchat_notices
				WHERE principal_id = ${principalId} AND (created_at, id) < (
					SELECT created_at, id FROM webchat_notices WHERE id = ${before}::uuid AND principal_id = ${principalId}
				) ORDER BY created_at DESC, id DESC LIMIT ${limit}`
			: await this
					.#sql`SELECT id, text, created_at, read_at FROM webchat_notices
				WHERE principal_id = ${principalId} ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
		return rows.map(noticeOf);
	}

	async read(principalId: string, id: string): Promise<Notice | undefined> {
		const rows: Row[] = await this
			.#sql`UPDATE webchat_notices SET read_at = COALESCE(read_at, NOW())
			WHERE principal_id = ${principalId} AND id = ${id}::uuid RETURNING *`;
		return rows[0] ? noticeOf(rows[0]) : undefined;
	}
}
