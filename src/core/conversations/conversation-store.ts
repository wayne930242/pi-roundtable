import type { SQL } from "bun";
import { parseChannelKey } from "../contract/surface.ts";
import type { Migration } from "../db/migrations.ts";
import type { ChannelKey } from "../sessions.ts";
import type {
	ConversationRecord,
	ConversationRegistration,
	ConversationRegistry,
	ConversationVisibility,
} from "./conversation-registry.ts";

interface Row {
	key: string;
	surface: string;
	kind: string;
	principal_id: string | null;
	visibility: ConversationVisibility;
	title: string | null;
	created_at: Date;
	last_active_at: Date;
}

function recordOf(row: Row): ConversationRecord {
	return {
		key: row.key as ChannelKey,
		surface: row.surface,
		kind: row.kind,
		visibility: row.visibility,
		...(row.principal_id === null ? {} : { principalId: row.principal_id }),
		...(row.title === null ? {} : { title: row.title }),
		createdAt: row.created_at,
		lastActiveAt: row.last_active_at,
	};
}

/** The conversation registry in the `conversations` table. */
export class PgConversationRegistry implements ConversationRegistry {
	readonly #sql: SQL;

	private constructor(sql: SQL) {
		this.#sql = sql;
	}

	/** The registry's table; the host runs this before the registry attaches. */
	static readonly migration: Migration = {
		name: "conversations",
		up: async (sql) => {
			await sql`
				CREATE TABLE IF NOT EXISTS conversations (
					key text PRIMARY KEY,
					surface text NOT NULL,
					kind text NOT NULL,
					principal_id text,
					visibility text NOT NULL CHECK (visibility IN ('private', 'shared')),
					title text,
					created_at timestamptz NOT NULL DEFAULT now(),
					last_active_at timestamptz NOT NULL DEFAULT now()
				)`;
			await sql`
				CREATE INDEX IF NOT EXISTS conversations_principal
				ON conversations (principal_id, last_active_at DESC)`;
		},
	};

	/** The registry over the host's migrated pool. */
	static async attach(sql: SQL): Promise<PgConversationRegistry> {
		return new PgConversationRegistry(sql);
	}

	async register(entry: ConversationRegistration): Promise<ConversationRecord> {
		const { surface } = parseChannelKey(entry.key);
		const rows: Row[] = await this.#sql`
			INSERT INTO conversations (key, surface, kind, principal_id, visibility, title)
			VALUES (${entry.key}, ${surface}, ${entry.kind}, ${entry.principalId ?? null},
				${entry.visibility}, ${entry.title ?? null})
			ON CONFLICT (key) DO UPDATE SET
				last_active_at = now(),
				-- Shared and no one's, as 0.8 recorded a turn run without a visibility: the first private
				-- turn makes it its speaker's. One with a principal never changes hands.
				visibility = CASE WHEN conversations.visibility = 'shared' AND conversations.principal_id IS NULL
					AND EXCLUDED.visibility = 'private' AND EXCLUDED.principal_id IS NOT NULL
					THEN 'private' ELSE conversations.visibility END,
				principal_id = CASE WHEN conversations.visibility = 'shared' AND conversations.principal_id IS NULL
					AND EXCLUDED.visibility = 'private' AND EXCLUDED.principal_id IS NOT NULL
					THEN EXCLUDED.principal_id ELSE conversations.principal_id END
			RETURNING *`;
		const [row] = rows;
		if (!row) throw new Error(`conversation ${entry.key} was not recorded`);
		return recordOf(row);
	}

	async get(key: ChannelKey): Promise<ConversationRecord | undefined> {
		const rows: Row[] = await this.#sql`
			SELECT * FROM conversations WHERE key = ${key}`;
		const [row] = rows;
		return row ? recordOf(row) : undefined;
	}

	async list(
		filter: { principal?: string } = {},
	): Promise<ConversationRecord[]> {
		const rows: Row[] =
			filter.principal === undefined
				? await this.#sql`
					SELECT * FROM conversations ORDER BY last_active_at DESC, key`
				: await this.#sql`
					SELECT * FROM conversations WHERE principal_id = ${filter.principal}
					ORDER BY last_active_at DESC, key`;
		return rows.map(recordOf);
	}

	async setTitle(
		key: ChannelKey,
		title: string | undefined,
	): Promise<ConversationRecord | undefined> {
		const rows: Row[] = await this.#sql`
			UPDATE conversations SET title = ${title ?? null} WHERE key = ${key}
			RETURNING *`;
		const [row] = rows;
		return row ? recordOf(row) : undefined;
	}
}
