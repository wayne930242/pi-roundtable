import type { SQL } from "bun";
import { nested, openPool, runMigrations } from "../../core/db/migrations.ts";
import { MigrationError } from "../../core/errors.ts";
import type { RoundtablePlugin } from "../../core/plugin.ts";
import type { Project } from "../project.ts";
import { fail, ok, type Result, skipped } from "../report.ts";

/** Asks PostgreSQL whether it answers and, given migrations, whether they run. */
export interface DatabasePort {
	check(
		url: string,
		plugins:
			| readonly Pick<RoundtablePlugin, "name" | "migrations">[]
			| undefined,
	): Promise<void>;
	/** Runs `use` on a pool of the database at `url`, closed after; `use` only reads. */
	read<T>(url: string, use: (sql: SQL) => Promise<T>): Promise<T>;
}

class Rollback extends Error {}

/**
 * The real port. The migrations run inside a transaction that is always rolled back: DDL in
 * PostgreSQL is transactional, so what the check proves it runs is exactly what the host runs,
 * and the database is left as it was.
 */
export const postgres: DatabasePort = {
	async check(url, plugins) {
		const pool = openPool(url);
		try {
			await pool`select 1`;
			if (!plugins) return;
			try {
				await pool.begin(async (transaction) => {
					await runMigrations(nested(transaction), plugins);
					throw new Rollback();
				});
			} catch (error) {
				if (!(error instanceof Rollback)) throw error;
			}
		} finally {
			await pool.close();
		}
	},
	async read(url, use) {
		const pool = openPool(url);
		try {
			return await use(pool);
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
	const plugins = assembled.ok ? assembled.value.defined.plugins : undefined;
	try {
		await port.check(url, plugins);
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
		plugins
			? `${where(url)} answers and the migrations run`
			: `${where(url)} answers; migrations are checked once the configuration is valid`,
	);
}
