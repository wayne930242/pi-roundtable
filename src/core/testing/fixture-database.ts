import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { testDatabaseUrl } from "./database.ts";

/** A scratch database on the test server; drop it when the test ends. */
export interface ScratchDatabase {
	url: string;
	sql: SQL;
	drop(): Promise<void>;
}

/**
 * A new, empty database on the test server, or one loaded from a recorded fixture such as
 * `"0.8.0"` (src/core/testing/fixtures/db-<version>.sql, written by scripts/fixture-db.ts). It
 * needs PostgreSQL: run it under `describeDb`.
 */
export async function scratchDatabase(
	fixture?: string,
): Promise<ScratchDatabase> {
	const name = `roundtable_scratch_${crypto.randomUUID().replaceAll("-", "")}`;
	let url: URL;
	try {
		url = new URL(testDatabaseUrl);
	} catch {
		throw new Error(
			`ROUNDTABLE_TEST_DATABASE_URL is not a postgres url: ${testDatabaseUrl}`,
		);
	}
	url.pathname = `/${name}`;
	const server = new SQL(testDatabaseUrl, { max: 1 });
	await server.unsafe(`CREATE DATABASE ${name}`);
	await server.close();
	const sql = new SQL(url.href, { max: 4 });
	if (fixture)
		await sql.unsafe(
			readFileSync(join(import.meta.dir, "fixtures", `db-${fixture}.sql`), "utf8"),
		);
	return {
		url: url.href,
		sql,
		drop: async () => {
			await sql.close();
			const admin = new SQL(testDatabaseUrl, { max: 1 });
			try {
				await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
			} finally {
				await admin.close();
			}
		},
	};
}
