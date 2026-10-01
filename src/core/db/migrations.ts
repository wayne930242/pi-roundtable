import { SQL, type TransactionSQL } from "bun";
import { MigrationError, PluginError } from "../errors.ts";
import type { RoundtablePlugin } from "../plugin.ts";

/** A plugin's tables, as DDL its `up` runs. */
export interface Migration {
	name: string;
	/**
	 * "once" (the default): the ledger records it, so it runs one time over a database and never
	 * again. "every-boot": runs at every boot and is never recorded; it must be idempotent, which
	 * suits a migration that converges data an older build may have written since.
	 */
	runs?: "once" | "every-boot";
	up(sql: SQL): Promise<void>;
}

/** What one boot's migrations did, each entry a ledger id (`<plugin>/<migration>`). */
export interface MigrationReport {
	/** The "once" migrations that ran now and were recorded. */
	applied: string[];
	/** The "once" migrations the ledger already held. */
	skipped: string[];
	/** The "every-boot" migrations that ran. */
	everyBoot: string[];
}

/**
 * The host's one connection pool. PostgreSQL's 100 connections are shared with the other services on the same server,
 * so the pool stays small and closes idle connections; Bun's defaults (10, never closed)
 * exhausted the server when every store kept its own.
 */
export function openPool(databaseUrl: string): SQL {
	return new SQL(databaseUrl, { max: 10, idleTimeout: 60 });
}

/**
 * The transaction as a migration sees the pool: a migration that opens its own transaction
 * with `begin` gets a savepoint of the running one, which PostgreSQL nests.
 */
export function nested(transaction: TransactionSQL): SQL {
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

/** Runs each migration in order, none of them recorded; a repeated name is a plugin bug, a failing one stops. Test setup uses it for tables a test drops and rebuilds. */
export async function migrate(
	sql: SQL,
	migrations: readonly Migration[],
): Promise<void> {
	const names = new Set<string>();
	for (const { name } of migrations) {
		if (names.has(name))
			throw new PluginError(`migration ${name} is declared twice`);
		names.add(name);
	}
	for (const migration of migrations) {
		try {
			await migration.up(sql);
		} catch (error) {
			throw new MigrationError(migration.name, error);
		}
	}
}

const LEDGER = "roundtable_migrations";

/** The lock key for one name; two hosts booting together queue on it instead of racing. */
const lockOf = (name: string) => `pi-roundtable:migration:${name}`;

/**
 * Runs every plugin's migrations in plugin order, then declaration order, the way a boot does. A
 * "once" migration runs inside its own transaction under an advisory lock, and the ledger row is
 * written in that transaction, so a migration that failed leaves no record and two hosts booting at
 * once apply it one time in total. An "every-boot" migration runs each time and is not recorded.
 */
export async function runMigrations(
	sql: SQL,
	plugins: readonly Pick<RoundtablePlugin, "name" | "migrations">[],
): Promise<MigrationReport> {
	const steps = plugins.flatMap((plugin) =>
		(plugin.migrations ?? []).map((migration) => ({
			id: `${plugin.name}/${migration.name}`,
			plugin: plugin.name,
			migration,
		})),
	);
	const ids = new Set<string>();
	for (const { id } of steps) {
		if (ids.has(id)) throw new PluginError(`migration ${id} is declared twice`);
		ids.add(id);
	}
	const report: MigrationReport = { applied: [], skipped: [], everyBoot: [] };
	if (steps.length === 0) return report;

	await sql.begin(async (tx) => {
		await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockOf("ledger")}, 0))`;
		await tx.unsafe(`
			CREATE TABLE IF NOT EXISTS ${LEDGER} (
				id text PRIMARY KEY,
				plugin text NOT NULL,
				name text NOT NULL,
				applied_at timestamptz NOT NULL DEFAULT now()
			)`);
	});

	for (const { id, plugin, migration } of steps) {
		try {
			if (migration.runs === "every-boot") {
				await migration.up(sql);
				report.everyBoot.push(id);
				continue;
			}
			const ran = await sql.begin(async (tx) => {
				await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockOf(id)}, 0))`;
				const [recorded] =
					await tx`SELECT 1 FROM roundtable_migrations WHERE id = ${id}`;
				if (recorded) return false;
				await migration.up(nested(tx));
				await tx`INSERT INTO roundtable_migrations (id, plugin, name) VALUES (${id}, ${plugin}, ${migration.name})`;
				return true;
			});
			(ran ? report.applied : report.skipped).push(id);
		} catch (error) {
			throw new MigrationError(id, error);
		}
	}
	return report;
}

/**
 * Runs these plugins' migrations over the database at `url` with the ledger and the lock a boot
 * uses, then closes its connection. Pass the plugins, with the names, the host runs: the ledger ids
 * come from them, so another name would record the same tables a second time under it.
 */
export async function migrateDatabase(
	url: string,
	plugins: readonly Pick<RoundtablePlugin, "name" | "migrations">[],
): Promise<MigrationReport> {
	const pool = new SQL(url, { max: 2 });
	try {
		return await runMigrations(pool, plugins);
	} finally {
		await pool.close();
	}
}
