import type { SQL } from "bun";

/** A table of the agent server and the columns that make a row unique inside one guild. */
export interface GuildTable {
	table: string;
	key: readonly string[];
}

/** Serializes concurrent boots of the same migration. */
const LOCK = 7284912301;

/**
 * Gives every row of the tables its guild and makes the guild part of the primary key, so
 * names are unique per guild. Rows without a guild belong to `guildId`, the guild the process
 * is configured for; rows of another guild are never touched. Idempotent, and all or nothing.
 */
export async function scopeToGuild(
	sql: SQL,
	guildId: string,
	tables: readonly GuildTable[],
): Promise<void> {
	await sql.begin(async (tx) => {
		await tx`SELECT pg_advisory_xact_lock(${LOCK})`;
		for (const { table, key } of tables) {
			await tx.unsafe(
				`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS guild_id text`,
			);
			await tx.unsafe(
				`UPDATE ${table} SET guild_id = $1 WHERE guild_id IS NULL`,
				[guildId],
			);
			await tx.unsafe(
				`ALTER TABLE ${table} ALTER COLUMN guild_id SET NOT NULL`,
			);
			await tx.unsafe(`
				DO $migration$
				DECLARE pk text;
				BEGIN
					SELECT c.conname INTO pk FROM pg_constraint c
					WHERE c.conrelid = '${table}'::regclass AND c.contype = 'p'
						AND NOT EXISTS (
							SELECT 1 FROM pg_attribute a
							WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
								AND a.attname = 'guild_id');
					IF pk IS NOT NULL THEN
						EXECUTE format('ALTER TABLE ${table} DROP CONSTRAINT %I', pk);
						ALTER TABLE ${table} ADD PRIMARY KEY (guild_id, ${key.join(", ")});
					END IF;
				END
				$migration$`);
		}
	});
}
