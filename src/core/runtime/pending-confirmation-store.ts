import type { SQL } from "bun";
import type { Migration } from "../db/migrations.ts";
import type {
	ChannelKey,
	HeldCall,
	PendingConfirmation,
} from "../domain/conversation.ts";

interface Row {
	selection_id: string;
	held_at: Date;
	calls: string;
	speaker_id: string | null;
	principal_id: string | null;
}

/** Each owner channel's held actions, in the database, so a restart keeps them. */
export class PendingConfirmationStore {
	readonly #sql: SQL;

	private constructor(sql: SQL) {
		this.#sql = sql;
	}

	/** The store's tables; the host runs this before any store attaches. */
	static readonly migration: Migration = {
		name: "held-actions",
		up: async (sql) => {
			await sql`
				CREATE TABLE IF NOT EXISTS held_actions (
					channel_key text PRIMARY KEY,
					selection_id text NOT NULL,
					held_at timestamptz NOT NULL,
					calls text NOT NULL
				)`;
		},
	};

	/** Who spoke the turn that held the actions, so only they and the owner approve them. */
	static readonly speakerMigration: Migration = {
		name: "held-actions-speaker",
		up: async (sql) => {
			await sql`ALTER TABLE held_actions ADD COLUMN IF NOT EXISTS speaker_id text`;
		},
	};

	/**
	 * The hold the speaker belongs to, by its `held_at`. 0.7 replaces a row's held actions and
	 * leaves `speaker_id` as it was, so after a rollback and an upgrade a speaker counts only while
	 * the row still holds the actions it was written with.
	 */
	static readonly speakerHoldMigration: Migration = {
		name: "held-actions-speaker-hold",
		up: async (sql) => {
			await sql`ALTER TABLE held_actions ADD COLUMN IF NOT EXISTS speaker_held_at timestamptz`;
		},
	};

	/**
	 * The principal of that speaker, who approves the actions on any of their identities. It
	 * belongs to the same hold as the speaker, so it counts only where `speaker_id` does.
	 */
	static readonly principalMigration: Migration = {
		name: "held-actions-principal",
		up: async (sql) => {
			await sql`ALTER TABLE held_actions ADD COLUMN IF NOT EXISTS principal_id text`;
		},
	};

	/** The store's migrations in order. */
	static migrations(): Migration[] {
		return [
			PendingConfirmationStore.migration,
			PendingConfirmationStore.speakerMigration,
			PendingConfirmationStore.speakerHoldMigration,
			PendingConfirmationStore.principalMigration,
		];
	}

	/** The store over the host's migrated pool. */
	static async attach(sql: SQL): Promise<PendingConfirmationStore> {
		return new PendingConfirmationStore(sql);
	}

	async load(channel: ChannelKey): Promise<PendingConfirmation | undefined> {
		// A speaker written with other held actions than the row's, or without its hold, is none.
		const rows: Row[] = await this.#sql`
			SELECT selection_id, held_at, calls,
				CASE WHEN speaker_held_at = held_at THEN speaker_id END AS speaker_id,
				CASE WHEN speaker_held_at = held_at THEN principal_id END AS principal_id
			FROM held_actions
			WHERE channel_key = ${channel}`;
		const row = rows[0];
		return row
			? {
					selectionId: row.selection_id,
					heldAt: row.held_at,
					// pi-lens-ignore: unchecked-throwing-call — this store wrote the JSON; a corrupt row should fail loudly
					calls: JSON.parse(row.calls) as HeldCall[],
					...(row.speaker_id === null ? {} : { speakerId: row.speaker_id }),
					...(row.speaker_id === null || row.principal_id === null
						? {}
						: { principalId: row.principal_id }),
				}
			: undefined;
	}

	/** Replaces the channel's held actions; none deletes the row. */
	async save(
		channel: ChannelKey,
		pending: PendingConfirmation | undefined,
	): Promise<void> {
		if (!pending) {
			await this.#sql`DELETE FROM held_actions WHERE channel_key = ${channel}`;
			return;
		}
		const speaker = pending.speakerId ?? null;
		const principal = speaker === null ? null : (pending.principalId ?? null);
		await this.#sql`
			INSERT INTO held_actions
				(channel_key, selection_id, held_at, calls, speaker_id, speaker_held_at, principal_id)
			VALUES (${channel}, ${pending.selectionId}, ${pending.heldAt},
				${JSON.stringify(pending.calls)}, ${speaker},
				${speaker === null ? null : pending.heldAt}, ${principal})
			ON CONFLICT (channel_key) DO UPDATE SET selection_id = EXCLUDED.selection_id,
				held_at = EXCLUDED.held_at, calls = EXCLUDED.calls,
				speaker_id = EXCLUDED.speaker_id, speaker_held_at = EXCLUDED.speaker_held_at,
				principal_id = EXCLUDED.principal_id`;
	}
}
