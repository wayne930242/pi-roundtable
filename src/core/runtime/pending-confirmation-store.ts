import type { SQL } from "bun";
import type { Migration } from "../db/migrations.ts";
import type {
	ChannelKey,
	HeldCall,
	PendingConfirmation,
} from "../domain/conversation.ts";
import type { ProfileId } from "../domain/profile.ts";

interface Row {
	profile: ProfileId;
	held_at: Date;
	calls: string;
}

/** Each owner channel's held actions, in the database, so a restart keeps them. */
export class PendingConfirmationStore {
	readonly #sql: SQL;

	private constructor(sql: SQL) {
		this.#sql = sql;
	}

	/** The store's tables; the host runs this before any store attaches. */
	static readonly migration: Migration = {
		name: "pending-confirmations",
		up: async (sql) => {
			await sql`
				CREATE TABLE IF NOT EXISTS pending_confirmations (
					channel_key text PRIMARY KEY,
					profile text NOT NULL,
					held_at timestamptz NOT NULL,
					calls text NOT NULL
				)`;
		},
	};

	/** The store over the host's migrated pool. */
	static async attach(sql: SQL): Promise<PendingConfirmationStore> {
		return new PendingConfirmationStore(sql);
	}

	async load(channel: ChannelKey): Promise<PendingConfirmation | undefined> {
		const rows: Row[] = await this.#sql`
			SELECT profile, held_at, calls FROM pending_confirmations
			WHERE channel_key = ${channel}`;
		const row = rows[0];
		return row
			? {
					profile: row.profile,
					heldAt: row.held_at,
					// pi-lens-ignore: unchecked-throwing-call — this store wrote the JSON; a corrupt row should fail loudly
					calls: JSON.parse(row.calls) as HeldCall[],
				}
			: undefined;
	}

	/** Replaces the channel's held actions; none deletes the row. */
	async save(
		channel: ChannelKey,
		pending: PendingConfirmation | undefined,
	): Promise<void> {
		if (!pending) {
			await this
				.#sql`DELETE FROM pending_confirmations WHERE channel_key = ${channel}`;
			return;
		}
		await this.#sql`
			INSERT INTO pending_confirmations (channel_key, profile, held_at, calls)
			VALUES (${channel}, ${pending.profile}, ${pending.heldAt},
				${JSON.stringify(pending.calls)})
			ON CONFLICT (channel_key) DO UPDATE SET profile = EXCLUDED.profile,
				held_at = EXCLUDED.held_at, calls = EXCLUDED.calls`;
	}
}
