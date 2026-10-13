import { SQL } from "bun";
import { testDatabaseUrl } from "pi-roundtable/testing";
import { MIGRATIONS } from "../migrations.ts";

/** A pool over the test database with the tables empty. */
export async function freshPool(): Promise<SQL> {
	const sql = new SQL(testDatabaseUrl, { max: 10 });
	for (const migration of MIGRATIONS) await migration.up(sql);
	await truncateAll(sql);
	return sql;
}

/** Empties every table of the package. */
export async function truncateAll(sql: SQL): Promise<void> {
	await sql`TRUNCATE line_inbox, line_sources, line_messages, line_message_refs, line_tombstones, line_outbox, line_notices`;
}
