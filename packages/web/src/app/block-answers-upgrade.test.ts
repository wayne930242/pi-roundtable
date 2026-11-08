import { expect, test } from "bun:test";
import { SQL } from "bun";
import { migrateDatabase } from "pi-roundtable";
import { describeDb, testDatabaseUrl } from "pi-roundtable/testing";
import { APP_MIGRATIONS } from "./migrations.ts";

const OLD_NAME = "web-room-block-answers";

/** The migration exactly as 0.40.0 released it: a released migration is never edited. */
const released040 = {
	name: OLD_NAME,
	up: async (sql: SQL) => {
		await sql`
			CREATE TABLE IF NOT EXISTS web_room_block_answers (
				room text NOT NULL,
				message_id bigint NOT NULL REFERENCES web_room_messages (id) ON DELETE CASCADE,
				block integer NOT NULL,
				fields jsonb NOT NULL,
				answered_by text NOT NULL,
				answered_at timestamptz NOT NULL DEFAULT now(),
				answer_message_id bigint,
				UNIQUE (room, message_id, block)
			)`;
		await sql`CREATE INDEX IF NOT EXISTS web_room_block_answers_answer ON web_room_block_answers (room, answer_message_id) WHERE answer_message_id IS NOT NULL`;
	},
};

describeDb("the block answers table on a database upgraded from 0.40.0", () => {
	test("boots the 0.40.0 migrations, then the current ones, and has the message index", async () => {
		const admin = new SQL(testDatabaseUrl, { max: 1 });
		const name = `upgrade_${process.pid}_${Date.now()}`;
		await admin.unsafe(`CREATE DATABASE ${name}`);
		const own = new URL(testDatabaseUrl);
		own.pathname = `/${name}`;
		const sql = new SQL(own.toString(), { max: 2 });
		try {
			const at040 = APP_MIGRATIONS.filter(
				(m) => m.name !== "web-room-block-answers-message-index",
			).map((m) => (m.name === OLD_NAME ? released040 : m));
			await migrateDatabase(own.toString(), [
				{ name: "web", migrations: at040 },
			]);
			const second = await migrateDatabase(own.toString(), [
				{ name: "web", migrations: APP_MIGRATIONS },
			]);
			expect(second.skipped).toContain(`web/${OLD_NAME}`);
			const rows: { indexdef: string }[] =
				await sql`SELECT indexdef FROM pg_indexes WHERE tablename = 'web_room_block_answers'`;
			expect(rows.some((row) => /\(message_id\)/.test(row.indexdef))).toBe(
				true,
			);
		} finally {
			await sql.close();
			await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
			await admin.close();
		}
	});
});
