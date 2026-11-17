import type { SQL } from "bun";
import type { Migration } from "../db/migrations.ts";

/** One addressed message the host took in. */
export interface JournalEntry {
	/** The bot that took it in, so two hosts on one database keep their records apart. */
	botId: string;
	messageId: string;
	channelId: string;
	/** Whether it came in a direct message, whose channel catch-up cannot list. */
	direct: boolean;
}

/**
 * The addressed messages the host took in, recorded before each is handed on: whoever records a
 * message first, the live gateway or catch-up after a restart, is the only one that delivers it.
 */
export interface InboundJournal {
	/** Records the message as taken in; false when it already was. */
	claim(entry: JournalEntry): Promise<boolean>;
	/** The bot's direct-message channels with a message recorded since `since`, the most recent first. */
	directChannels(botId: string, since: Date, limit: number): Promise<string[]>;
	/** Forgets what was recorded before `before`. */
	prune(before: Date): Promise<void>;
}

const migration: Migration = {
	name: "discord-inbound-journal",
	up: async (sql) => {
		await sql`
			CREATE TABLE IF NOT EXISTS discord_inbound_journal (
				bot_id text NOT NULL,
				message_id text NOT NULL,
				channel_id text NOT NULL,
				direct boolean NOT NULL,
				recorded_at timestamptz NOT NULL DEFAULT now(),
				PRIMARY KEY (bot_id, message_id)
			)`;
		await sql`
			CREATE INDEX IF NOT EXISTS discord_inbound_journal_recorded
				ON discord_inbound_journal (recorded_at)`;
	},
};

/**
 * The journal over the host's pool, built from closures rather than private fields, so a test
 * proxy can carry it. One insert that does nothing on a conflict decides who records a message.
 */
export const PgInboundJournal = {
	migration,
	attach(sql: SQL): InboundJournal {
		return {
			async claim({ botId, messageId, channelId, direct }) {
				const rows: unknown[] = await sql`
					INSERT INTO discord_inbound_journal (bot_id, message_id, channel_id, direct)
					VALUES (${botId}, ${messageId}, ${channelId}, ${direct})
					ON CONFLICT (bot_id, message_id) DO NOTHING
					RETURNING message_id`;
				return rows.length > 0;
			},
			async directChannels(botId, since, limit) {
				const rows: { channel_id: string }[] = await sql`
					SELECT channel_id FROM discord_inbound_journal
					WHERE bot_id = ${botId} AND direct AND recorded_at >= ${since}
					GROUP BY channel_id
					ORDER BY max(recorded_at) DESC
					LIMIT ${limit}`;
				return rows.map((row) => row.channel_id);
			},
			async prune(before) {
				await sql`DELETE FROM discord_inbound_journal WHERE recorded_at < ${before}`;
			},
		};
	},
};
