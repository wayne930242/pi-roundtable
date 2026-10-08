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

export interface NoticeLimits {
	messageChars?: number;
	maxBufferedBytes?: number;
}

/** Fixed retention and text caps bound storage and REST response sizes. */
export const MAX_NOTICES = 100;
const MAX_NOTICE_CHARS = 4096;
// ASCII UUID and timestamps plus JSON field names fit within this reserve.
const FRAME_OVERHEAD = 256;

/** Notices scoped by principal in every query, including marking one read. */
export class PgNotices {
	readonly #sql: SQL;
	readonly #textChars: number;

	constructor(sql: SQL, limits: NoticeLimits = {}) {
		this.#sql = sql;
		const bytes = limits.maxBufferedBytes ?? 4 * 1024 * 1024;
		const chars = limits.messageChars ?? 32_000;
		if (!Number.isSafeInteger(bytes) || bytes < FRAME_OVERHEAD + 6)
			throw new Error(
				"webChat: maxBufferedBytes must be an integer of at least 262 bytes to carry a notice frame",
			);
		if (!Number.isSafeInteger(chars) || chars < 1)
			throw new Error("webChat: messageChars must be a positive integer");
		// One UTF-16 unit costs at most six bytes after JSON escaping, including
		// control characters and lone surrogates. Reserve space for the envelope.
		this.#textChars = Math.min(
			chars,
			MAX_NOTICE_CHARS,
			Math.floor((bytes - FRAME_OVERHEAD) / 6),
		);
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
		const bounded =
			text.length > this.#textChars
				? `${text.slice(0, this.#textChars - 1)}…`
				: text;
		return this.#sql.begin(async (sql) => {
			// Serialize insert/prune for one inbox even across pools/processes.
			await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`webchat-notices:${principalId}`}, 0))`;
			const rows: Row[] =
				await sql`INSERT INTO webchat_notices (principal_id, id, text, created_at)
				VALUES (${principalId}, ${crypto.randomUUID()}, ${bounded}, clock_timestamp()) RETURNING *`;
			if (!rows[0]) throw new Error("webchat notice insert returned no row");
			await sql`DELETE FROM webchat_notices WHERE principal_id = ${principalId} AND id IN (
				SELECT id FROM webchat_notices WHERE principal_id = ${principalId}
				ORDER BY created_at DESC, id DESC OFFSET ${MAX_NOTICES}
			)`;
			return noticeOf(rows[0]);
		});
	}

	/** Latest entries, with a bounded page; before is the last id of the previous page. */
	async list(
		principalId: string,
		limit = 50,
		before?: string,
	): Promise<Notice[]> {
		limit = Number.isInteger(limit)
			? Math.min(Math.max(limit, 1), MAX_NOTICES)
			: 50;
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
