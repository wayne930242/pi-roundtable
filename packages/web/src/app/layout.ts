import type { SQL } from "bun";
import type { Migration } from "pi-roundtable";
import type { LayoutView } from "../api-types.ts";

/** What the layout routes need of the stored arrangement; `RoomLayout` is the database's. */
export interface LayoutStore {
	/** Everything stored, including rooms that no longer exist. */
	view(): Promise<LayoutView>;
	/**
	 * Applies an edit to the stored layout as one step that no other edit overlaps, and returns the
	 * result. An edit that throws changes nothing.
	 */
	change(edit: (layout: LayoutView) => LayoutView): Promise<LayoutView>;
}

interface FolderRow {
	id: string;
	name: string;
}
interface RoomRow {
	room: string;
	folder: string;
}

/**
 * The arrangement of the room list, shared by every owner and device: the pinned rooms
 * (`web_room_pins`), the folders (`web_room_folders`) and the rooms in them
 * (`web_room_folder_rooms`). Positions are dense (0..n-1) within each list and rewritten on every
 * change under one advisory lock, so two devices editing at once cannot leave a gap or a duplicate.
 * Rows of rooms that no longer exist are kept, so a re-created agent returns to its place.
 */
export class RoomLayout implements LayoutStore {
	readonly #sql: SQL;

	constructor(sql: SQL) {
		this.#sql = sql;
	}

	static readonly migration: Migration = {
		name: "web-room-layout",
		up: async (sql) => {
			await sql`
				CREATE TABLE IF NOT EXISTS web_room_folders (
					id text PRIMARY KEY,
					name text NOT NULL,
					position integer NOT NULL,
					created_at timestamptz NOT NULL DEFAULT now()
				)`;
			await sql`
				CREATE TABLE IF NOT EXISTS web_room_folder_rooms (
					room text PRIMARY KEY,
					folder text NOT NULL REFERENCES web_room_folders (id) ON DELETE CASCADE,
					position integer NOT NULL
				)`;
			await sql`CREATE INDEX IF NOT EXISTS web_room_folder_rooms_folder ON web_room_folder_rooms (folder, position)`;
			await sql`
				CREATE TABLE IF NOT EXISTS web_room_pins (
					room text PRIMARY KEY,
					position integer NOT NULL
				)`;
		},
	};

	async view(): Promise<LayoutView> {
		return this.#sql.begin(async (tx) => read(tx));
	}

	async change(edit: (layout: LayoutView) => LayoutView): Promise<LayoutView> {
		return this.#sql.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(hashtextextended('web-room-layout', 0))`;
			const before = await read(tx);
			const after = edit(before);
			if (JSON.stringify(after) !== JSON.stringify(before))
				await write(tx, after);
			return after;
		});
	}
}

async function read(tx: SQL): Promise<LayoutView> {
	const folders: FolderRow[] = await tx`
		SELECT id, name FROM web_room_folders ORDER BY position, created_at, id`;
	const inside: RoomRow[] = await tx`
		SELECT room, folder FROM web_room_folder_rooms ORDER BY folder, position`;
	const pins: { room: string }[] = await tx`
		SELECT room FROM web_room_pins ORDER BY position`;
	return {
		pins: pins.map((row) => row.room),
		folders: folders.map((folder) => ({
			id: folder.id,
			name: folder.name,
			rooms: inside
				.filter((row) => row.folder === folder.id)
				.map((r) => r.room),
		})),
	};
}

/** Rewrites the three tables to match the layout, positions dense. */
async function write(tx: SQL, layout: LayoutView): Promise<void> {
	await tx`DELETE FROM web_room_folder_rooms`;
	await tx`DELETE FROM web_room_pins`;
	const ids = layout.folders.map((folder) => folder.id);
	if (ids.length === 0) await tx`DELETE FROM web_room_folders`;
	else await tx`DELETE FROM web_room_folders WHERE id NOT IN ${tx(ids)}`;
	for (const [position, folder] of layout.folders.entries())
		await tx`
			INSERT INTO web_room_folders (id, name, position)
			VALUES (${folder.id}, ${folder.name}, ${position})
			ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, position = EXCLUDED.position`;
	const pins = layout.pins.map((room, position) => ({ room, position }));
	if (pins.length > 0) await tx`INSERT INTO web_room_pins ${tx(pins)}`;
	const placed = layout.folders.flatMap((folder) =>
		folder.rooms.map((room, position) => ({
			room,
			folder: folder.id,
			position,
		})),
	);
	if (placed.length > 0)
		await tx`INSERT INTO web_room_folder_rooms ${tx(placed)}`;
}
