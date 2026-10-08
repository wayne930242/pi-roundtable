import type { SQL } from "bun";

/** The tables of principals, their identities, and their roles. */
export const PRINCIPAL_TABLES = async (sql: SQL): Promise<void> => {
	await sql`
		CREATE TABLE IF NOT EXISTS principals (
			id text PRIMARY KEY,
			display_name text NOT NULL,
			pronouns text CHECK (pronouns IN ('he', 'she', 'they')),
			locale text,
			time_zone text,
			created_at timestamptz NOT NULL DEFAULT now(),
			disabled_at timestamptz,
			last_seen_at timestamptz,
			last_tier text CHECK (last_tier IN ('member', 'admin', 'owner'))
		)`;
	await sql`
		CREATE TABLE IF NOT EXISTS principal_identities (
			provider text NOT NULL,
			subject text NOT NULL,
			principal_id text NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
			linked_at timestamptz NOT NULL DEFAULT now(),
			source text NOT NULL CHECK (source IN ('config', 'cli', 'jit', 'legacy')),
			PRIMARY KEY (provider, subject)
		)`;
	await sql`
		CREATE INDEX IF NOT EXISTS principal_identities_principal
		ON principal_identities (principal_id)`;
	await sql`
		CREATE TABLE IF NOT EXISTS principal_roles (
			principal_id text NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
			role text NOT NULL CHECK (role IN ('member', 'admin', 'owner')),
			source text NOT NULL CHECK (source IN ('config', 'cli')),
			granted_at timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (principal_id, role)
		)`;
};

/**
 * Whether the person of a carried-over principal's 0.8 id may still claim it: its own migration,
 * so a database whose principals table an earlier build made gets the column too.
 */
export const PRINCIPALS_CLAIMABLE = async (sql: SQL): Promise<void> => {
	await sql`ALTER TABLE principals ADD COLUMN IF NOT EXISTS claimable boolean NOT NULL DEFAULT false`;
};

/** Links a plugin declares: their own source, beside the four the tables were made with. */
export const PRINCIPAL_PLUGIN_LINKS = async (sql: SQL): Promise<void> => {
	await sql`ALTER TABLE principal_identities DROP CONSTRAINT IF EXISTS principal_identities_source_check`;
	await sql`
		ALTER TABLE principal_identities ADD CONSTRAINT principal_identities_source_check
		CHECK (source IN ('config', 'plugin', 'cli', 'jit', 'legacy'))`;
};
