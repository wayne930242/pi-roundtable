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
	/** Records the message as taken in, or takes one a stopping process left; false when it is taken. */
	claim(entry: JournalEntry): Promise<boolean>;
	/** The bot's direct-message channels with a message recorded since `since`, the most recent first. */
	directChannels(botId: string, since: Date, limit: number): Promise<string[]>;
	/** Records a message this process took in as left, as it stops before running it, for the next process to take. */
	leave(entry: JournalEntry): Promise<void>;
	/** Records a message no one took in yet as left; false when someone did, and it is theirs. */
	leaveNew(entry: JournalEntry): Promise<boolean>;
	/** The messages left since `since`, the oldest first. */
	left(botId: string, since: Date): Promise<JournalEntry[]>;
	/**
	 * Which of the bot's own messages `ids` are recorded: the notices it posted while it shut down,
	 * which say a message will be answered after the restart rather than answer it. No other message
	 * of the bot's is recorded, since only a person's is ever taken in.
	 */
	recordedAmong(botId: string, ids: string[]): Promise<Set<string>>;
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
/** Marks a message left by a stopping process, so the next one answers it whatever the channel shows. */
const leftMigration: Migration = {
	name: "discord-inbound-journal-left",
	up: async (sql) => {
		await sql`
			ALTER TABLE discord_inbound_journal ADD COLUMN IF NOT EXISTS left_at timestamptz`;
	},
};

export const PgInboundJournal = {
	migrations: [migration, leftMigration],
	attach(sql: SQL): InboundJournal {
		return {
			async claim({ botId, messageId, channelId, direct }) {
				const rows: unknown[] = await sql`
					INSERT INTO discord_inbound_journal (bot_id, message_id, channel_id, direct)
					VALUES (${botId}, ${messageId}, ${channelId}, ${direct})
					ON CONFLICT (bot_id, message_id) DO UPDATE SET left_at = NULL
					WHERE discord_inbound_journal.left_at IS NOT NULL
					RETURNING message_id`;
				return rows.length > 0;
			},
			async leave({ botId, messageId, channelId, direct }) {
				await sql`
					INSERT INTO discord_inbound_journal (bot_id, message_id, channel_id, direct, left_at)
					VALUES (${botId}, ${messageId}, ${channelId}, ${direct}, now())
					ON CONFLICT (bot_id, message_id) DO UPDATE SET left_at = now()`;
			},
			async leaveNew({ botId, messageId, channelId, direct }) {
				const rows: unknown[] = await sql`
					INSERT INTO discord_inbound_journal (bot_id, message_id, channel_id, direct, left_at)
					VALUES (${botId}, ${messageId}, ${channelId}, ${direct}, now())
					ON CONFLICT (bot_id, message_id) DO NOTHING
					RETURNING message_id`;
				return rows.length > 0;
			},
			async left(botId, since) {
				const rows: {
					message_id: string;
					channel_id: string;
					direct: boolean;
				}[] = await sql`
						SELECT message_id, channel_id, direct FROM discord_inbound_journal
						WHERE bot_id = ${botId} AND left_at >= ${since}
						ORDER BY left_at`;
				return rows.map((row) => ({
					botId,
					messageId: row.message_id,
					channelId: row.channel_id,
					direct: row.direct,
				}));
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
			async recordedAmong(botId, ids) {
				if (ids.length === 0) return new Set();
				const rows: { message_id: string }[] = await sql`
					SELECT message_id FROM discord_inbound_journal
					WHERE bot_id = ${botId} AND message_id IN ${sql(ids)}`;
				return new Set(rows.map((row) => row.message_id));
			},
			async prune(before) {
				await sql`DELETE FROM discord_inbound_journal WHERE recorded_at < ${before}`;
			},
		};
	},
};
