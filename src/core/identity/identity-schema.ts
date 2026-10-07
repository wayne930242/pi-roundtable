import type { SQL } from "bun";
import type { Migration } from "../db/migrations.ts";
import { type Tier, tierAtLeast } from "../speakers.ts";
import type { AccessRules, AccessTier } from "./access-policy.ts";
import { parseIdentity } from "./actor-facts.ts";
import {
	LEGACY_PROVIDER,
	LEGACY_REMOTE_SPEAKER,
	PRINCIPAL_TABLES,
	PRINCIPALS_CLAIMABLE,
	SYSTEM_PRINCIPAL,
} from "./principal-store.ts";

/** Where the backfill finds the ids of people 0.8 stored: the configured owners, then four tables. */
export type BackfillSource =
	| "config"
	| "owner_memory"
	| "schedules"
	| "conversations"
	| "held_actions";

/** The rules the backfill reads: the owners with a principal id, made first by their names, and the tiers that cap what a carried-over author of schedules is seen at. */
export type BackfillRules = Pick<AccessRules, "owners" | "admins" | "members">;

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

/** Whether the tier's rules could hold the person of a 0.8 speaker id, whose surface and roles are unknown here. */
function couldHold(tier: AccessTier | undefined, id: string): boolean {
	if (!tier) return false;
	const { everyone } = tier;
	if (everyone === true || (Array.isArray(everyone) && everyone.length > 0))
		return true;
	if ((tier.roles?.length ?? 0) > 0) return true;
	return (tier.identities ?? []).some(
		(identity) => identity === id || parseIdentity(identity)?.subject === id,
	);
}

/** The most the rules could give the person of a 0.8 speaker id: admin, member, or nothing; never owner, which only the owners hold. */
function ceilingOf(
	rules: BackfillRules,
	id: string,
): Exclude<Tier, "owner"> | undefined {
	if (couldHold(rules.admins, id)) return "admin";
	if (couldHold(rules.members, id)) return "member";
	return undefined;
}

/** The highest tier each author created a schedule at, where the table records it. */
async function scheduledTiers(sql: SQL): Promise<Map<string, Tier>> {
	const tiers = new Map<string, Tier>();
	if (
		!(
			(await hasColumn(sql, "schedules", "created_by_id")) &&
			(await hasColumn(sql, "schedules", "created_tier"))
		)
	)
		return tiers;
	const rows = (await sql`
		SELECT created_by_id AS id, created_tier AS tier FROM schedules
		WHERE created_by_id IS NOT NULL`) as { id: string; tier: Tier }[];
	for (const { id, tier } of rows) {
		const best = tiers.get(id);
		if (!best || tierAtLeast(tier, best)) tiers.set(id, tier);
	}
	return tiers;
}

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

/** The tier a carried-over author of schedules is seen at: the highest they scheduled at, at most what the rules could give them. */
function seenTier(
	rules: BackfillRules,
	id: string,
	scheduled: ReadonlyMap<string, Tier>,
): Tier | null {
	const tier = scheduled.get(id);
	const ceiling = tier && ceilingOf(rules, id);
	if (!tier || !ceiling) return null;
	return tierAtLeast(tier, ceiling) ? ceiling : tier;
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
 * `principal_id`, whose `speaker_id` is an actor id this version stored, and any id a surface
 * knows a linked identity by (its subject, or `<provider>:<subject>`, as `ActorFacts.legacyId`
 * names it): that person has a principal already, and this version wrote the row, so the boot
 * after someone is admitted makes no second principal of their actor id. Each but a configured
 * owner is claimable once, by the person of that id at their first contact
 * (IdentityService.resolve); a configured owner never is, even once the configuration names
 * another owner. 0.8's `remote-mcp` speaker, the owner writing over MCP, gets no principal: it is
 * linked as `legacy:remote-mcp` to the primary owner's, so what it created stays the owner's. One that created
 * schedules, other than a configured owner, is recorded as seen now at the highest tier it
 * scheduled at, capped at the most the rules could give it, so its schedules keep running until
 * `backgroundStaleDays` pass unseen. It only inserts, so it changes no row, and a second run
 * makes nothing; an id an older build wrote since gets its principal at the next run. The owners
 * are named as configured, a schedule's author as the schedule names them, anyone else by their
 * id. `dryRun` counts and writes nothing. The system principal is never made.
 */
export async function backfillPrincipals(
	sql: SQL,
	rules: BackfillRules,
	options: { dryRun?: boolean } = {},
): Promise<BackfillSummary> {
	const owners = rules.owners.flatMap((owner) =>
		owner.principal === undefined
			? []
			: [{ id: owner.principal, name: owner.name }],
	);
	const names = new Map<string, string | undefined>();
	const sources = {
		config: 0,
		owner_memory: 0,
		schedules: 0,
		conversations: 0,
		held_actions: 0,
	} satisfies Record<BackfillSource, number>;
	// 0.8's remote-mcp speaker was the owner over MCP: it stands for the primary owner.
	const primary = owners[0]?.id;
	let remote = false;
	const add = (source: BackfillSource, id: string, name: string | null) => {
		if (id === SYSTEM_PRINCIPAL) return;
		sources[source]++;
		if (primary !== undefined && id === LEGACY_REMOTE_SPEAKER) {
			remote = true;
			return;
		}
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
	// The id a surface knows a linked person by is no 0.8 speaker's: this version wrote it.
	const linked = new Set<string>(
		table?.made
			? (
					(await sql`SELECT provider, subject FROM principal_identities`) as {
						provider: string;
						subject: string;
					}[]
				).flatMap((row) => [row.subject, `${row.provider}:${row.subject}`])
			: [],
	);
	const missing = [...names].filter(
		([id]) => !existing.has(id) && !linked.has(id),
	);
	if (options.dryRun) return { created: missing.length, sources };
	const scheduled = await scheduledTiers(sql);
	const configured = new Set(owners.map((owner) => owner.id));
	const upgraded = new Date();
	let created = 0;
	for (const [id, displayName] of missing) {
		const owner = configured.has(id);
		const seen = owner ? null : seenTier(rules, id, scheduled);
		const rows = await sql`
			INSERT INTO principals (id, display_name, claimable, last_tier, last_seen_at)
			VALUES (${id}, ${displayName ?? id}, ${!owner}, ${seen}, ${seen ? upgraded : null})
			ON CONFLICT (id) DO NOTHING
			RETURNING id`;
		created += rows.length;
	}
	if (remote && primary !== undefined)
		await sql`
			INSERT INTO principal_identities (provider, subject, principal_id, source)
			VALUES (${LEGACY_PROVIDER}, ${LEGACY_REMOTE_SPEAKER}, ${primary}, 'legacy')
			ON CONFLICT (provider, subject) DO NOTHING`;
	// An owner is one by the configuration, never by a claim, even after it names someone else.
	if (configured.size > 0)
		await sql`
			UPDATE principals SET claimable = false
			WHERE claimable AND id IN ${sql([...configured])}`;
	return { created, sources };
}

/**
 * The identity plugin's migrations: its tables once, the claimable column once (apart, so a
 * database an earlier build made the tables on gets it too), then the backfill at every boot, which
 * hands its summary to `report`.
 */
export function identityMigrations(
	rules: BackfillRules,
	report?: (summary: BackfillSummary) => void,
): Migration[] {
	return [
		{ name: "principals", up: PRINCIPAL_TABLES },
		{ name: "principals-claimable", up: PRINCIPALS_CLAIMABLE },
		{
			name: "backfill",
			runs: "every-boot",
			up: async (sql) => {
				const summary = await backfillPrincipals(sql, rules);
				report?.(summary);
			},
		},
	];
}
