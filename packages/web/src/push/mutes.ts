import type { SQL } from "bun";
import type { Migration } from "pi-roundtable";

/**
 * The rooms whose owners asked for no push, one row per muted room in `web_push_muted_rooms`.
 * A mute belongs to the room, not to a device or a person: every owner's devices follow it.
 */
export class PushMutes {
	readonly #sql: SQL;

	constructor(sql: SQL) {
		this.#sql = sql;
	}

	static readonly migration: Migration = {
		name: "web-push-muted-rooms",
		up: async (sql) => {
			await sql`
				CREATE TABLE IF NOT EXISTS web_push_muted_rooms (
					room text PRIMARY KEY,
					muted_by text NOT NULL,
					muted_at timestamptz NOT NULL DEFAULT now()
				)`;
		},
	};

	/** Whether the room is muted. */
	async has(room: string): Promise<boolean> {
		const rows: unknown[] = await this
			.#sql`SELECT 1 FROM web_push_muted_rooms WHERE room = ${room}`;
		return rows.length > 0;
	}

	/** Every muted room. */
	async all(): Promise<Set<string>> {
		const rows: { room: string }[] = await this
			.#sql`SELECT room FROM web_push_muted_rooms`;
		return new Set(rows.map((row) => row.room));
	}

	/** Mutes or unmutes a room; doing either twice leaves it as it is. */
	async set(room: string, muted: boolean, by: string): Promise<void> {
		if (muted)
			await this.#sql`
				INSERT INTO web_push_muted_rooms (room, muted_by) VALUES (${room}, ${by})
				ON CONFLICT (room) DO NOTHING`;
		else await this.#sql`DELETE FROM web_push_muted_rooms WHERE room = ${room}`;
	}
}
