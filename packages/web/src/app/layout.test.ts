import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { describeDb, testDatabaseUrl } from "pi-roundtable/testing";
import type { LayoutView } from "../api-types.ts";
import {
	createFolder,
	LayoutError,
	placeFolder,
	placeRoom,
	removeFolder,
	setPinned,
} from "../layout-order.ts";
import { PushMutes } from "../push/mutes.ts";
import { RoomLayout } from "./layout.ts";

const A = "app:agent.layout-a";
const B = "app:agent.layout-b";
const C = "app:agent.layout-c";

describeDb("the room list's layout in the database", () => {
	let sql: SQL;
	let layout: RoomLayout;
	beforeAll(async () => {
		// The tables are created if absent and never dropped: the host-migrated ledger would not recreate them.
		sql = new SQL(testDatabaseUrl, { max: 8 });
		await RoomLayout.migration.up(sql);
		layout = new RoomLayout(sql);
	});
	afterAll(async () => {
		await sql`DELETE FROM web_room_folder_rooms`;
		await sql`DELETE FROM web_room_pins`;
		await sql`DELETE FROM web_room_folders`;
		await sql.close();
	});
	beforeEach(async () => {
		await sql`DELETE FROM web_room_folder_rooms`;
		await sql`DELETE FROM web_room_pins`;
		await sql`DELETE FROM web_room_folders`;
	});

	const folderIn = (name: string) => (view: LayoutView) =>
		createFolder(view, `folder.${name}`, name);
	/** Every position stored, to check that each list counts 0..n-1 without a gap or a repeat. */
	async function positions() {
		const folders: { position: number }[] = await sql`
			SELECT position FROM web_room_folders ORDER BY position`;
		const pins: { position: number }[] = await sql`
			SELECT position FROM web_room_pins ORDER BY position`;
		const rooms: { folder: string; position: number }[] = await sql`
			SELECT folder, position FROM web_room_folder_rooms ORDER BY folder, position`;
		return { folders, pins, rooms };
	}
	const dense = (list: { position: number }[]) =>
		list.map((row) => row.position).every((value, at) => value === at);

	test("the migration can run again over its own tables", async () => {
		await RoomLayout.migration.up(sql);
		await RoomLayout.migration.up(sql);
		const rows: { name: string | null }[] = await sql`
			SELECT to_regclass('web_room_folders') AS name
			UNION ALL SELECT to_regclass('web_room_folder_rooms')
			UNION ALL SELECT to_regclass('web_room_pins')`;
		expect(rows.map((row) => row.name)).toEqual([
			"web_room_folders",
			"web_room_folder_rooms",
			"web_room_pins",
		]);
	});

	test("a fresh store is an empty layout", async () => {
		expect(await layout.view()).toEqual({ pins: [], folders: [] });
	});

	test("folders, pins and rooms come back in the order they were placed, positions dense", async () => {
		await layout.change(folderIn("Work"));
		await layout.change(folderIn("Play"));
		await layout.change((view) =>
			placeFolder(view, "folder.Play", "folder.Work"),
		);
		await layout.change((view) => placeRoom(view, A, "folder.Work", null));
		await layout.change((view) => placeRoom(view, B, "folder.Work", null));
		await layout.change((view) => placeRoom(view, C, "folder.Work", B));
		await layout.change((view) => setPinned(view, A, true, null));
		await layout.change((view) => setPinned(view, B, true, A));
		expect(await layout.view()).toEqual({
			pins: [B, A],
			folders: [
				{ id: "folder.Play", name: "Play", rooms: [] },
				{ id: "folder.Work", name: "Work", rooms: [C] },
			],
		});
		const stored = await positions();
		expect(dense(stored.folders)).toBe(true);
		expect(dense(stored.pins)).toBe(true);
		expect(stored.rooms).toEqual([{ folder: "folder.Work", position: 0 }]);
	});

	test("an edit that is refused changes nothing, and removing a folder drops its rooms from it", async () => {
		await layout.change(folderIn("Work"));
		await layout.change((view) => placeRoom(view, A, "folder.Work", null));
		await expect(layout.change(folderIn("work"))).rejects.toBeInstanceOf(
			LayoutError,
		);
		expect((await layout.view()).folders).toHaveLength(1);
		await layout.change((view) => removeFolder(view, "folder.Work"));
		expect(await layout.view()).toEqual({ pins: [], folders: [] });
		const left: unknown[] = await sql`SELECT 1 FROM web_room_folder_rooms`;
		expect(left).toEqual([]);
	});

	test("a room that no longer exists keeps its place until its folder goes", async () => {
		await layout.change(folderIn("Work"));
		await layout.change((view) =>
			placeRoom(view, "app:agent.deleted", "folder.Work", null),
		);
		await layout.change((view) => placeRoom(view, A, "folder.Work", null));
		expect((await layout.view()).folders[0]?.rooms).toEqual([
			"app:agent.deleted",
			A,
		]);
	});

	test("ten concurrent edits leave unique, dense positions", async () => {
		for (const name of ["F0", "F1", "F2", "F3", "F4"])
			await layout.change(folderIn(name));
		const rooms = Array.from({ length: 10 }, (_, i) => `app:agent.layout-${i}`);
		await Promise.all(
			rooms.map((room, i) =>
				layout.change((view) =>
					i % 3 === 0
						? setPinned(view, room, true, null)
						: placeRoom(view, room, `folder.F${i % 5}`, null),
				),
			),
		);
		await Promise.all(
			["F4", "F3", "F2", "F1", "F0"].map((name) =>
				layout.change((view) =>
					placeFolder(view, `folder.${name}`, "folder.F0"),
				),
			),
		);
		const view = await layout.view();
		const placed = [...view.pins, ...view.folders.flatMap((f) => f.rooms)];
		expect(new Set(placed).size).toBe(10);
		expect(placed.sort()).toEqual([...rooms].sort());
		expect(view.folders).toHaveLength(5);
		const stored = await positions();
		expect(dense(stored.folders)).toBe(true);
		expect(dense(stored.pins)).toBe(true);
		const byFolder = Map.groupBy(stored.rooms, (row) => row.folder);
		for (const rows of byFolder.values()) expect(dense(rows)).toBe(true);
	});

	test("a folder's rooms are muted and unmuted in one step, each room once", async () => {
		await PushMutes.migration.up(sql);
		const mutes = new PushMutes(sql);
		const rooms = [A, B, C];
		await sql`DELETE FROM web_push_muted_rooms WHERE room IN ${sql(rooms)}`;
		try {
			await mutes.set(B, true, "ada");
			await mutes.setMany(rooms, true, "owner");
			await mutes.setMany([], true, "owner");
			const on: { room: string; muted_by: string }[] = await sql`
				SELECT room, muted_by FROM web_push_muted_rooms WHERE room IN ${sql(rooms)} ORDER BY room`;
			// The room that was muted before keeps who muted it.
			expect(on).toEqual([
				{ room: A, muted_by: "owner" },
				{ room: B, muted_by: "ada" },
				{ room: C, muted_by: "owner" },
			]);
			await mutes.setMany([A, C], false, "owner");
			expect(
				[...(await mutes.all())].filter((room) => rooms.includes(room)),
			).toEqual([B]);
		} finally {
			await sql`DELETE FROM web_push_muted_rooms WHERE room IN ${sql(rooms)}`;
		}
	});
});
