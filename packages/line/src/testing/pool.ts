import { SQL } from "bun";
import { testDatabaseUrl } from "pi-roundtable/testing";
import { INBOX_MIGRATION } from "../migrations.ts";

/** A pool over the test database with the tables empty. */
export async function freshPool(): Promise<SQL> {
	const sql = new SQL(testDatabaseUrl, { max: 10 });
	await INBOX_MIGRATION.up(sql);
	await sql`TRUNCATE line_inbox, line_sources`;
	return sql;
}
