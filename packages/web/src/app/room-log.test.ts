import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { describeDb, testDatabaseUrl } from "pi-roundtable/testing";
import { RoomLog } from "./room-log.ts";

const ROOM = "app:agent.roomlog-json";
const FILE = { id: "f1", name: "notes.md", type: "text/markdown", size: 12 };

describeDb("the room log's jsonb columns", () => {
	let sql: SQL;
	let log: RoomLog;
	beforeAll(async () => {
		// The tables are created if absent and never dropped: the host-migrated ledger would not recreate them.
		sql = new SQL(testDatabaseUrl, { max: 2 });
		await RoomLog.migration.up(sql);
		await RoomLog.hostMigration.up(sql);
		await RoomLog.noteMigration.up(sql);
		await RoomLog.intercomMigration.up(sql);
		log = new RoomLog(sql);
		await sql`DELETE FROM web_room_messages WHERE room = ${ROOM}`;
	});
	afterAll(async () => {
		await sql`DELETE FROM web_room_messages WHERE room = ${ROOM}`;
		await sql.close();
	});

	test("a stored message keeps its files as a JSON array", async () => {
		const message = await log.append({
			room: ROOM,
			kind: "agent",
			author: "Ada",
			text: "here",
			files: [FILE],
			picture: { file: "p1" },
		});
		expect(message.files).toEqual([FILE]);
		const [row] = await sql`
			SELECT jsonb_typeof(files) AS files, jsonb_typeof(picture) AS picture
			FROM web_room_messages WHERE id = ${message.id}`;
		expect(row).toEqual({ files: "array", picture: "object" });
		expect((await log.get(ROOM, message.id))?.files).toEqual([FILE]);
	});

	test("the migration turns files stored as a JSON string into the array, and can run again", async () => {
		const [stored] = await sql`
			INSERT INTO web_room_messages (room, kind, author_name, text, files, intercom)
			VALUES (${ROOM}, 'agent', 'Ada', 'old', to_jsonb(${JSON.stringify([FILE])}::text),
				to_jsonb(${JSON.stringify({ way: "in", agent: "bob" })}::text))
			RETURNING id`;
		const typeOf = async () =>
			(
				await sql`
					SELECT jsonb_typeof(files) AS files, jsonb_typeof(intercom) AS intercom
					FROM web_room_messages WHERE id = ${stored.id}`
			)[0];
		expect(await typeOf()).toEqual({ files: "string", intercom: "string" });
		// The reader stays tolerant of rows the migration has not reached.
		expect((await log.get(ROOM, Number(stored.id)))?.files).toEqual([FILE]);
		await RoomLog.jsonValuesMigration.up(sql);
		await RoomLog.jsonValuesMigration.up(sql);
		expect(await typeOf()).toEqual({ files: "array", intercom: "object" });
		expect((await log.get(ROOM, Number(stored.id)))?.files).toEqual([FILE]);
	});
});
