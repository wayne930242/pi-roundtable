import type { SQL, TransactionSQL } from "bun";
import type { Migration } from "../../core/db/migrations.ts";
import { migrate, openPool } from "../../core/db/migrations.ts";
import { MigrationError } from "../../core/errors.ts";
import type { Project } from "../project.ts";
import { fail, ok, type Result, skipped } from "../report.ts";

/** Asks PostgreSQL whether it answers and, given migrations, whether they run. */
export interface DatabasePort {
	check(
		url: string,
		migrations: readonly Migration[] | undefined,
	): Promise<void>;
}

class Rollback extends Error {}

/**
 * The transaction as a migration sees the pool: a migration that opens its own transaction
 * with `begin` gets a savepoint of the checking one, which PostgreSQL nests.
 */
function nested(transaction: TransactionSQL): SQL {
	return new Proxy(transaction, {
		get(target, property) {
			if (property === "begin")
				return (...args: Parameters<TransactionSQL["savepoint"]>) =>
					target.savepoint(...args);
			const value: unknown = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/**
 * The real port. The migrations run inside a transaction that is always rolled back: DDL in
 * PostgreSQL is transactional, so what the check proves it runs is exactly what the host runs,
 * and the database is left as it was.
 */
export const postgres: DatabasePort = {
	async check(url, migrations) {
		const pool = openPool(url);
		try {
			await pool`select 1`;
			if (!migrations) return;
			try {
				await pool.begin(async (transaction) => {
					await migrate(nested(transaction), migrations);
					throw new Rollback();
				});
			} catch (error) {
				if (!(error instanceof Rollback)) throw error;
			}
		} finally {
			await pool.close();
		}
	},
};

/** The address without its password, safe to print. */
function where(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname}`;
	} catch {
		return "the configured database";
	}
}

/** PostgreSQL reachable, and every plugin's migrations able to run on it. */
export async function checkDatabase(
	project: Project,
	port: DatabasePort,
): Promise<Result> {
	const url = await project.text("database", "url");
	if (!url) return skipped("database.url has no value");
	const assembled = await project.assembled();
	const migrations = assembled.ok
		? assembled.value.defined.plugins.flatMap(
				(plugin) => plugin.migrations ?? [],
			)
		: undefined;
	try {
		await port.check(url, migrations);
	} catch (error) {
		if (error instanceof MigrationError)
			return fail(
				`migration ${error.migration} failed: ${String(error.cause)}`,
				"Fix the migration, or restore the database to the state it expects.",
			);
		return fail(
			`cannot use ${where(url)}: ${error instanceof Error ? error.message : String(error)}`,
			"Start PostgreSQL (`docker compose up -d` in this project) or correct DATABASE_URL in .env.",
		);
	}
	return ok(
		migrations
			? `${where(url)} answers and the migrations run`
			: `${where(url)} answers; migrations are checked once the configuration is valid`,
	);
}
