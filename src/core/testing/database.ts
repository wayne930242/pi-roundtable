import { describe } from "bun:test";
import type { SQL } from "bun";
import { type Migration, migrate, openPool } from "../db/migrations.ts";

// PostgreSQL-backed tests run only when ROUNDTABLE_TEST_DATABASE_URL points at a test database.
// Repository CI requires it in the workflow; consumers without it skip these suites.
const url = process.env.ROUNDTABLE_TEST_DATABASE_URL;

/** The guild the stores of the tests serve. */
export const TEST_GUILD = "900000000000000001";

export const testDatabaseUrl = url ?? "";

export const describeDb = url ? describe : describe.skip;

/** A test pool with the migrations run, as the host runs them before any store attaches; the caller closes it. */
export async function migratedPool(...migrations: Migration[]): Promise<SQL> {
	const sql = openPool(testDatabaseUrl);
	await migrate(sql, migrations);
	return sql;
}

/** A store with its own migrated test pool, as stores opened before the host owned the pool. */
export type TestStore<T> = T & { close(): Promise<void> };

/** Migrates a pool for the store alone and attaches it; closing the store closes that pool. */
export async function openTestStore<T extends object, A extends unknown[]>(
	Store: {
		migration: Migration;
		/** The migrations to run when the store's arguments decide them, such as a guild. */
		migrations?(...args: A): Migration[];
		attach(sql: SQL, ...args: A): T | Promise<T>;
	},
	...args: A
): Promise<TestStore<T>> {
	const sql = await migratedPool(
		...(Store.migrations?.(...args) ?? [Store.migration]),
	);
	try {
		const store = await Store.attach(sql, ...args);
		return Object.assign(store, { close: () => sql.close() });
	} catch (error) {
		await sql.close();
		throw error;
	}
}
