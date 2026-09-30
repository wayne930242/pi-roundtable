import { SQL } from "bun";
import { MigrationError, PluginError } from "../errors.ts";

/** Idempotent DDL a plugin's tables need; every boot runs it again over the existing schema. */
export interface Migration {
	name: string;
	up(sql: SQL): Promise<void>;
}

/**
 * The host's one connection pool. PostgreSQL's 100 connections are shared with the other services on the same server,
 * so the pool stays small and closes idle connections; Bun's defaults (10, never closed)
 * exhausted the server when every store kept its own.
 */
export function openPool(databaseUrl: string): SQL {
	return new SQL(databaseUrl, { max: 10, idleTimeout: 60 });
}

/** Runs the migrations in order; a repeated name is a plugin bug, a failing one stops the boot. */
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
