import type { SQL } from "bun";
import type { Migration } from "../db/migrations.ts";
import { PRINCIPAL_TABLES, SYSTEM_PRINCIPAL } from "./principal-store.ts";

/** Where the backfill finds the ids of people 0.8 stored: the configured owners, then four tables. */
export type BackfillSource =
	| "config"
	| "owner_memory"
	| "schedules"
	| "conversations"
	| "held_actions";

/** A configured owner whose principal id is known, the old `owner.id`. */
export interface BackfillOwner {
	id: string;
	name: string;
}

/** What one backfill made: the principals it created, and how many distinct ids each source held. */
export interface BackfillSummary {
	created: number;
	sources: Record<BackfillSource, number>;
}

/**
 * The column each table keeps a person's id in, and the column naming them, where there is one.
 * `principal` is a column a newer build fills with the principal beside an actor id: a row with
 * it filled is not 0.8's, so its id makes no principal.
 */
const TABLES: readonly {
	table: Exclude<BackfillSource, "config">;
	column: string;
	name?: string;
	order?: string;
	principal?: string;
}[] = [
	{ table: "owner_memory", column: "speaker_id" },
	{
		table: "schedules",
		column: "created_by_id",
		name: "created_by_name",
		order: "created_at DESC",
	},
	{ table: "conversations", column: "principal_id" },
	{ table: "held_actions", column: "speaker_id", principal: "principal_id" },
];

async function hasColumn(
	sql: SQL,
	table: string,
	column: string,
): Promise<boolean> {
	const rows = await sql`
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = ${table} AND column_name = ${column}`;
	return rows.length > 0;
}

/** The ids a table holds, each with the name it last gave them, or none. */
async function idsIn(
	sql: SQL,
	source: (typeof TABLES)[number],
): Promise<{ id: string; name: string | null }[]> {
	if (!(await hasColumn(sql, source.table, source.column))) return [];
	// The identifiers are this module's constants, never input.
	const name = source.name ?? "NULL::text";
	const order = source.order ? `, ${source.order}` : "";
	const legacy =
		source.principal && (await hasColumn(sql, source.table, source.principal))
			? ` AND ${source.principal} IS NULL`
			: "";
	return (await sql.unsafe(
		`SELECT DISTINCT ON (${source.column}) ${source.column} AS id, ${name} AS name
		FROM ${source.table} WHERE ${source.column} IS NOT NULL AND ${source.column} <> ''${legacy}
		ORDER BY ${source.column}${order}`,
	)) as { id: string; name: string | null }[];
}

/**
 * Makes a principal of the same id for every person 0.8 stored: the configured owners, and each
 * id in `owner_memory`, `schedules`, `conversations`, and `held_actions`, skipping a table or a
 * column the database does not have yet, and a held action that names its principal in
 * `principal_id`, whose `speaker_id` is an actor id this version stored. Each is claimable once, by the person of that id at
 * their first contact (IdentityService.resolve). It only inserts, so it changes no row, and a second run
 * makes nothing; an id an older build wrote since gets its principal at the next run. The owners
 * are named as configured, a schedule's author as the schedule names them, anyone else by their
 * id. `dryRun` counts and writes nothing. The system principal is never made.
 */
export async function backfillPrincipals(
	sql: SQL,
	owners: readonly BackfillOwner[],
	options: { dryRun?: boolean } = {},
): Promise<BackfillSummary> {
	const names = new Map<string, string | undefined>();
	const sources = {
		config: 0,
		owner_memory: 0,
		schedules: 0,
		conversations: 0,
		held_actions: 0,
	} satisfies Record<BackfillSource, number>;
	const add = (source: BackfillSource, id: string, name: string | null) => {
		if (id === SYSTEM_PRINCIPAL) return;
		sources[source]++;
		if (!names.get(id)) names.set(id, name?.trim() || undefined);
	};
	for (const owner of owners) add("config", owner.id, owner.name);
	for (const source of TABLES)
		for (const row of await idsIn(sql, source))
			add(source.table, row.id, row.name);

	const [table] = await sql`SELECT to_regclass('principals') AS made`;
	const existing = new Set<string>(
		table?.made
			? (await sql`SELECT id FROM principals`).map(
					(row: { id: string }) => row.id,
				)
			: [],
	);
	const missing = [...names].filter(([id]) => !existing.has(id));
	if (options.dryRun) return { created: missing.length, sources };
	let created = 0;
	for (const [id, displayName] of missing) {
		const rows = await sql`
			INSERT INTO principals (id, display_name, claimable) VALUES (${id}, ${displayName ?? id}, true)
			ON CONFLICT (id) DO NOTHING
			RETURNING id`;
		created += rows.length;
	}
	return { created, sources };
}

/**
 * The identity plugin's migrations: its tables once, then the backfill at every boot, which
 * hands its summary to `report`.
 */
export function identityMigrations(
	owners: readonly BackfillOwner[],
	report?: (summary: BackfillSummary) => void,
): Migration[] {
	return [
		{ name: "principals", up: PRINCIPAL_TABLES },
		{
			name: "backfill",
			runs: "every-boot",
			up: async (sql) => {
				const summary = await backfillPrincipals(sql, owners);
				report?.(summary);
			},
		},
	];
}
