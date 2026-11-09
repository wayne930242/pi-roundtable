import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { describeDb, testDatabaseUrl } from "pi-roundtable/testing";
import {
	createFolder,
	placeRoom,
	setHidden,
	setPinned,
} from "../layout-order.ts";
import { RoomLayout } from "./layout.ts";

const A = "app:agent.hidden-a";
const B = "app:agent.hidden-b";

describeDb("the hidden rooms in the database", () => {
	let sql: SQL;
	let layout: RoomLayout;
	beforeAll(async () => {
		// The tables are created if absent and never dropped: the host-migrated ledger would not recreate them.
		sql = new SQL(testDatabaseUrl, { max: 4 });
		await RoomLayout.migration.up(sql);
		await RoomLayout.hiddenMigration.up(sql);
		layout = new RoomLayout(sql);
	});
	const clear = async () => {
		await sql`DELETE FROM web_room_hidden`;
		await sql`DELETE FROM web_room_folder_rooms`;
		await sql`DELETE FROM web_room_pins`;
		await sql`DELETE FROM web_room_folders`;
	};
	beforeEach(clear);
	afterAll(async () => {
		await clear();
		await sql.close();
	});

	test("the migration has its own ledger name and can run again over its table", async () => {
		expect(RoomLayout.hiddenMigration.name).toBe("web-room-hidden");
		await RoomLayout.hiddenMigration.up(sql);
		await RoomLayout.hiddenMigration.up(sql);
		const rows: { name: string | null }[] = await sql`
			SELECT to_regclass('web_room_hidden') AS name`;
		expect(rows[0]?.name).toBe("web_room_hidden");
	});

	test("a hidden room is stored with who hid it, keeps its pin and folder rows, and returns on unhide", async () => {
		await layout.change((view) => createFolder(view, "folder.Work", "Work"));
		await layout.change((view) => placeRoom(view, A, "folder.Work", null));
		await layout.change((view) => setPinned(view, B, true, null));
		await layout.change(
			(view) => setHidden(setHidden(view, A, true), B, true),
			"owner-1",
		);
		const stored: { room: string; hidden_by: string }[] = await sql`
			SELECT room, hidden_by FROM web_room_hidden ORDER BY room`;
		expect(stored).toEqual([
			{ room: A, hidden_by: "owner-1" },
			{ room: B, hidden_by: "owner-1" },
		]);
		const view = await layout.view();
		expect(view.hidden.sort()).toEqual([A, B]);
		expect(view.pins).toEqual([B]);
		expect(view.folders[0]?.rooms).toEqual([A]);
		// A later edit by someone else does not take the first owner's name off the rows.
		await layout.change((one) => setPinned(one, A, false, null), "owner-2");
		await layout.change((one) => setHidden(one, A, false), "owner-2");
		expect((await layout.view()).hidden).toEqual([B]);
		const left: { hidden_by: string }[] =
			await sql`SELECT hidden_by FROM web_room_hidden`;
		expect(left).toEqual([{ hidden_by: "owner-1" }]);
	});

	test("a room hidden with no one to name is refused and nothing is stored", async () => {
		await expect(
			layout.change((view) => setHidden(view, A, true)),
		).rejects.toThrow(/who hid/);
		expect((await layout.view()).hidden).toEqual([]);
	});

	test("forgetting a room drops its hidden row too", async () => {
		await layout.change((view) => setHidden(view, A, true), "owner-1");
		await layout.forget(A);
		expect((await layout.view()).hidden).toEqual([]);
		const left: unknown[] = await sql`SELECT 1 FROM web_room_hidden`;
		expect(left).toEqual([]);
	});
});
