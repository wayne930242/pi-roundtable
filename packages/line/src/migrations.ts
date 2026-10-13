import type { Migration } from "pi-roundtable";

/**
 * The sources and the inbox. Later migrations add the tables of messages, tombstones and the
 * outbox; this one is never edited once released.
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
