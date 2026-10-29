import type { SQL } from "bun";
import type { Migration } from "pi-roundtable";

/** Where one person has read a room up to. */
export interface ReadMark {
	principalId: string;
	/** The id of the newest message they have read. */
	upTo: number;
	/** ISO time. */
	at: string;
}

interface MarkRow {
	principal_id: string;
	last_read_id: string | number | bigint;
	read_at: Date;
}

/**
 * The read cursors, one per person and room, kept in `web_room_reads`. A cursor only moves
 * forward: reading an older message again, or a second device that is behind, changes nothing.
 * A message counts as unread for a person when it is newer than their cursor and is not a line the
 * server wrote (a divider, a yolo approval), which is nobody's to read.
 */
export class RoomReads {
	readonly #sql: SQL;

	constructor(sql: SQL) {
		this.#sql = sql;
	}

	static readonly migration: Migration = {
		name: "web-room-reads",
		up: async (sql) => {
			await sql`
				CREATE TABLE IF NOT EXISTS web_room_reads (
					room text NOT NULL,
					principal_id text NOT NULL,
					last_read_id bigint NOT NULL,
					read_at timestamptz NOT NULL DEFAULT now(),
					PRIMARY KEY (room, principal_id)
				)`;
		},
	};

	/**
	 * Moves the person's cursor in the room up to `upTo`, no further than the room's newest
	 * message. The mark when the cursor moved, undefined when it stayed where it was.
	 */
	async advance(
		room: string,
		principalId: string,
		upTo: number,
	): Promise<ReadMark | undefined> {
		const [row]: MarkRow[] = await this.#sql`
			INSERT INTO web_room_reads (room, principal_id, last_read_id)
			SELECT ${room}, ${principalId}, LEAST(${upTo}::bigint, newest.id)
			FROM (SELECT COALESCE(max(id), 0) AS id FROM web_room_messages WHERE room = ${room}) AS newest
			WHERE newest.id > 0
			ON CONFLICT (room, principal_id) DO UPDATE
				SET last_read_id = EXCLUDED.last_read_id, read_at = now()
				WHERE web_room_reads.last_read_id < EXCLUDED.last_read_id
			RETURNING principal_id, last_read_id, read_at`;
		return row && markOf(row);
	}

	/** The person's cursor in the room, or undefined when they never read it. */
	async cursorOf(
		room: string,
		principalId: string,
	): Promise<number | undefined> {
		const [row]: { last_read_id: string | number | bigint }[] = await this.#sql`
			SELECT last_read_id FROM web_room_reads
			WHERE room = ${room} AND principal_id = ${principalId}`;
		return row === undefined ? undefined : Number(row.last_read_id);
	}

	/** Everyone's cursor in the room: who has read up to where. */
	async marks(room: string): Promise<ReadMark[]> {
		const rows: MarkRow[] = await this.#sql`
			SELECT principal_id, last_read_id, read_at FROM web_room_reads
			WHERE room = ${room} ORDER BY read_at`;
		return rows.map(markOf);
	}

	/**
	 * How many messages each room holds past the person's cursor. A person who never read a room
	 * has every message to read, unless `baseline` names the room: its cursor is then set to the
	 * newest message the first time it is asked, so what was there before they could have read
	 * anything counts as read. Rooms with nothing unread are left out.
	 */
	async unread(
		principalId: string,
		rooms: readonly string[],
		baseline: ReadonlySet<string> = new Set(),
	): Promise<Map<string, number>> {
		const counts = new Map<string, number>();
		if (rooms.length === 0) return counts;
		const start = rooms.filter((room) => baseline.has(room));
		if (start.length > 0) {
			await this.#sql`
				INSERT INTO web_room_reads (room, principal_id, last_read_id)
				SELECT room, ${principalId}, max(id) FROM web_room_messages
				WHERE room IN ${this.#sql(start)} GROUP BY room
				ON CONFLICT (room, principal_id) DO NOTHING`;
			// A room with nothing in it yet starts at the beginning, so what is first said there is unread.
			const held: { room: string }[] = await this.#sql`
				SELECT room FROM web_room_reads
				WHERE principal_id = ${principalId} AND room IN ${this.#sql(start)}`;
			const have = new Set(held.map((row) => row.room));
			const empty = start
				.filter((room) => !have.has(room))
				.map((room) => ({
					room,
					principal_id: principalId,
					last_read_id: 0,
				}));
			if (empty.length > 0)
				await this.#sql`
					INSERT INTO web_room_reads ${this.#sql(empty)}
					ON CONFLICT (room, principal_id) DO NOTHING`;
		}
		const rows: { room: string; unread: string | number | bigint }[] =
			await this.#sql`
			SELECT m.room, count(*) AS unread
			FROM web_room_messages m
			LEFT JOIN web_room_reads r ON r.room = m.room AND r.principal_id = ${principalId}
			WHERE m.room IN ${this.#sql(rooms)} AND m.kind <> 'system'
				AND m.id > COALESCE(r.last_read_id, 0)
			GROUP BY m.room`;
		for (const row of rows) counts.set(row.room, Number(row.unread));
		return counts;
	}

	/** Forgets the cursors of rooms that are gone. */
	async removeRoom(room: string): Promise<void> {
		await this.#sql`DELETE FROM web_room_reads WHERE room = ${room}`;
	}

	/** Forgets the cursors of rooms of a kind whose messages are all gone. */
	async sweepOrphans(prefix: string): Promise<void> {
		await this.#sql`
			DELETE FROM web_room_reads r
			WHERE starts_with(r.room, ${prefix})
				AND NOT EXISTS (SELECT 1 FROM web_room_messages m WHERE m.room = r.room)`;
	}
}

function markOf(row: MarkRow): ReadMark {
	return {
		principalId: row.principal_id,
		upTo: Number(row.last_read_id),
		at: row.read_at.toISOString(),
	};
}
