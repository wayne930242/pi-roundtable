import type { Migration } from "pi-roundtable";

/**
 * The sources and the inbox. Later migrations add the tables of messages, tombstones and the
 * outbox; this one is never edited once released, and a migration is only ever appended.
 */
export const INBOX_MIGRATION: Migration = {
	name: "inbox",
	up: async (sql) => {
		await sql`CREATE TABLE IF NOT EXISTS line_sources (
			source_key TEXT PRIMARY KEY,
			kind TEXT NOT NULL CHECK (kind IN ('group', 'room', 'user')),
			status TEXT NOT NULL CHECK (status IN ('pending', 'allowed', 'left', 'blocked')),
			first_seen_at TIMESTAMPTZ NOT NULL,
			last_seen_at TIMESTAMPTZ NOT NULL,
			status_changed_at TIMESTAMPTZ NOT NULL,
			event_count BIGINT NOT NULL DEFAULT 0,
			message_count BIGINT NOT NULL DEFAULT 0,
			membership_ts BIGINT NOT NULL DEFAULT 0
		)`;
		await sql`CREATE TABLE IF NOT EXISTS line_inbox (
			seq BIGSERIAL NOT NULL,
			webhook_event_id TEXT PRIMARY KEY,
			source_key TEXT,
			event_type TEXT NOT NULL,
			message_id TEXT,
			event_ts BIGINT NOT NULL,
			payload JSONB,
			status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'done', 'skipped', 'dead')),
			attempts INTEGER NOT NULL DEFAULT 0,
			requeues INTEGER NOT NULL DEFAULT 0,
			next_attempt_at TIMESTAMPTZ NOT NULL,
			claimed_at TIMESTAMPTZ,
			last_error_code TEXT,
			created_at TIMESTAMPTZ NOT NULL,
			completed_at TIMESTAMPTZ
		)`;
		await sql`CREATE INDEX IF NOT EXISTS line_inbox_claim
			ON line_inbox (event_ts, seq) WHERE status = 'pending'`;
		await sql`CREATE INDEX IF NOT EXISTS line_inbox_processing
			ON line_inbox (source_key) WHERE status = 'processing'`;
		await sql`CREATE INDEX IF NOT EXISTS line_inbox_message
			ON line_inbox (message_id) WHERE message_id IS NOT NULL`;
	},
};

/**
 * What the consumer keeps about a message while it is mirrored: its tokens, the opaque references
 * the subscriber returned, and the tombstones that stop an unsent message from being mirrored.
 * Every row goes after the retention window.
 */
export const MESSAGES_MIGRATION: Migration = {
	name: "messages",
	up: async (sql) => {
		await sql`CREATE TABLE IF NOT EXISTS line_messages (
			source_key TEXT NOT NULL,
			message_id TEXT NOT NULL,
			message_type TEXT NOT NULL,
			event_ts BIGINT NOT NULL,
			reply_token TEXT,
			reply_token_at TIMESTAMPTZ,
			quote_token TEXT,
			edit_ts BIGINT NOT NULL DEFAULT 0,
			created_at TIMESTAMPTZ NOT NULL,
			PRIMARY KEY (source_key, message_id)
		)`;
		await sql`CREATE TABLE IF NOT EXISTS line_message_refs (
			source_key TEXT NOT NULL,
			message_id TEXT NOT NULL,
			ref TEXT NOT NULL,
			position INTEGER NOT NULL,
			created_at TIMESTAMPTZ NOT NULL,
			PRIMARY KEY (source_key, message_id, ref)
		)`;
		await sql`CREATE TABLE IF NOT EXISTS line_tombstones (
			source_key TEXT NOT NULL,
			message_id TEXT NOT NULL,
			created_at TIMESTAMPTZ NOT NULL,
			PRIMARY KEY (source_key, message_id)
		)`;
		await sql`CREATE INDEX IF NOT EXISTS line_messages_age ON line_messages (created_at)`;
		await sql`CREATE INDEX IF NOT EXISTS line_message_refs_age ON line_message_refs (created_at)`;
		await sql`CREATE INDEX IF NOT EXISTS line_tombstones_age ON line_tombstones (created_at)`;
		await sql`CREATE INDEX IF NOT EXISTS line_tombstones_message ON line_tombstones (message_id)`;
		// The retention sweeper looks at finished events by their completion time and at waiting ones by age.
		await sql`CREATE INDEX IF NOT EXISTS line_inbox_finished
			ON line_inbox (completed_at) WHERE status IN ('done', 'skipped', 'dead')`;
		await sql`CREATE INDEX IF NOT EXISTS line_inbox_waiting_age
			ON line_inbox (created_at) WHERE status = 'pending'`;
	},
};

/** Every migration of the package, in the order they run. */
export const MIGRATIONS: Migration[] = [INBOX_MIGRATION, MESSAGES_MIGRATION];
