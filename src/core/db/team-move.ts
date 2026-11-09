import { LEGACY_CHANNEL_TABLES } from "./legacy-channels.ts";
import type { Migration } from "./migrations.ts";

export interface TeamMoveOptions {
	/** The ids the team was stored under before, such as a Discord guild it no longer lives in. */
	from: readonly string[];
	/** The team's id now. */
	to: string;
	/**
	 * The Discord guild the team's channels live in. The channel ids of the rows moved from any other
	 * former id are cleared: they name channels of a guild the team left, so start creates new ones.
	 */
	discordGuild?: string;
	/**
	 * The team has no Discord channels: the channel ids of the rows it moves, and of the rows it
	 * already holds, are cleared. Default false.
	 */
	clearChannels?: boolean;
	/**
	 * The surfaces whose stored places name something of the space the team lived in, such as the
	 * channels of a Discord guild. A place row moved from a former id other than `keep` is dropped, as
	 * the legacy channel ids are cleared, so start makes new places; without `keep` every moved row
	 * is dropped. With `clearChannels` the team's own rows of these surfaces go too.
	 */
	places?: readonly { surface: string; keep?: string }[];
}

/** The tables whose rows hold a legacy channel id. */
const CHANNEL_TABLES = new Set(Object.keys(LEGACY_CHANNEL_TABLES));

/** The table of stored places: its second unique key is a place id, which no two owners of a team share. */
const PLACES_TABLE = "agent_places";

/**
 * Moves a former team's rows to the team id: every row of a table with a `guild_id` (or, for places, `team_id`) column whose id
 * is one of `from`, in the tables the host's plugins keep (agents, groups, skills, prompts, presets,
 * outbox, conversations, places). Rows of other guilds stay, such as the `discord_*` grants and audit of the
 * guilds a bot still serves. A row whose key, or for places whose id, the team already holds stays where it is (a warning
 * names it), so a second boot changes nothing; of two former ids holding one key, the one listed
 * first moves.
 *
 * It runs at every boot, after the migrations that create the tables and before any setup, so the
 * team's seeds find their agents already moved.
 */
export function moveTeam(options: TeamMoveOptions): Migration {
	const from = [...new Set(options.from)].filter((id) => id !== options.to);
	return {
		name: "team-move",
		runs: "every-boot",
		up: (sql) =>
			sql.begin(async (tx) => {
				if (from.length === 0 && !options.clearChannels) return;
				const tables: { table: string; scope: string; key: string[] | null }[] =
					await tx`
					SELECT c.table_name AS table, c.column_name AS scope,
						(SELECT array_agg(a.attname::text ORDER BY a.attnum)
							FROM pg_constraint p
							JOIN pg_attribute a
								ON a.attrelid = p.conrelid AND a.attnum = ANY (p.conkey)
							WHERE p.conrelid = format('%I', c.table_name)::regclass
								AND p.contype = 'p' AND a.attname <> c.column_name) AS key
					FROM information_schema.columns c
					JOIN information_schema.tables t
						ON t.table_schema = c.table_schema AND t.table_name = c.table_name
					WHERE c.table_schema = current_schema()
						AND c.column_name IN ('guild_id', 'team_id')
						AND t.table_type = 'BASE TABLE' AND c.table_name NOT LIKE 'discord\\_%'
					ORDER BY c.table_name`;
				for (const { table, scope, key } of tables) {
					const channels = CHANNEL_TABLES.has(table);
					if (options.clearChannels && channels)
						await tx.unsafe(
							`UPDATE "${table}" SET channel_id = NULL WHERE ${scope} = $1 AND channel_id IS NOT NULL`,
							[options.to],
						);
					if (table === PLACES_TABLE)
						for (const { surface, keep } of options.places ?? []) {
							if (options.clearChannels)
								await tx.unsafe(
									`DELETE FROM "${table}" WHERE ${scope} = $1 AND surface = $2`,
									[options.to, surface],
								);
							// The places of a former id whose space is not the team's now name nothing it can reach.
							await tx.unsafe(
								`DELETE FROM "${table}" WHERE ${scope} = ANY ($1::text[]) AND surface = $2 AND ${scope} IS DISTINCT FROM $3::text`,
								[from, surface, keep ?? null],
							);
						}
					const match = (key ?? [])
						.map((column) => `l."${column}" = t."${column}"`)
						.join(" AND ");
					// One former id at a time, in the listed order: the first to hold a key wins, and the
					// later ones find it taken.
					for (const id of from) {
						const same =
							table === PLACES_TABLE
								? ` AND NOT EXISTS (SELECT 1 FROM "${table}" l WHERE l.${scope} = $1 AND l.surface = t.surface AND l.external_id = t.external_id)`
								: "";
						const taken = match
							? ` AND NOT EXISTS (SELECT 1 FROM "${table}" l WHERE l.${scope} = $1 AND ${match})${same}`
							: same;
						const clear =
							channels &&
							(options.clearChannels ||
								(options.discordGuild !== undefined &&
									id !== options.discordGuild))
								? ", channel_id = NULL"
								: "";
						await tx.unsafe(
							`UPDATE "${table}" t SET ${scope} = $1${clear} WHERE t.${scope} = $2${taken}`,
							[options.to, id],
						);
					}
					if (!match || from.length === 0) continue;
					// A place also stays when the team holds its id on the surface, which the key does not show.
					const sameId =
						table === PLACES_TABLE
							? ` OR EXISTS (SELECT 1 FROM "${table}" l WHERE l.${scope} = $1 AND l.surface = t.surface AND l.external_id = t.external_id)`
							: "";
					const kept: Record<string, unknown>[] = await tx.unsafe(
						`SELECT t.${scope} AS moved_from, ${key?.map((column) => `t."${column}"`).join(", ")} FROM "${table}" t
							WHERE t.${scope} = ANY ($2::text[])
								AND (EXISTS (SELECT 1 FROM "${table}" l WHERE l.${scope} = $1 AND ${match})${sameId})`,
						[options.to, from],
					);
					if (kept.length > 0)
						console.warn(
							`team-move: ${kept.length} row(s) of "${table}" stay under their former id, because team "${options.to}" already holds the same ${sameId ? "key or place id" : "key"}: ${kept
								.map(
									({ moved_from, ...rest }) =>
										`${moved_from}/${Object.values(rest).join("/")}`,
								)
								.join(", ")}`,
						);
				}
			}),
	};
}
