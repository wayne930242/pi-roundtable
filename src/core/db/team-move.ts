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
}

/** The tables whose rows hold a Discord channel id. */
const CHANNEL_TABLES = new Set(["agents", "agent_groups"]);

/**
 * Moves a former team's rows to the team id: every row of a table with a `guild_id` column whose id
 * is one of `from`, in the tables the host's plugins keep (agents, groups, skills, prompts, presets,
 * outbox, conversations). Rows of other guilds stay, such as the `discord_*` grants and audit of the
 * guilds a bot still serves. A row whose key the team already holds stays where it is (a warning
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
				const tables: { table: string; key: string[] | null }[] = await tx`
					SELECT c.table_name AS table,
						(SELECT array_agg(a.attname::text ORDER BY a.attnum)
							FROM pg_constraint p
							JOIN pg_attribute a
								ON a.attrelid = p.conrelid AND a.attnum = ANY (p.conkey)
							WHERE p.conrelid = format('%I', c.table_name)::regclass
								AND p.contype = 'p' AND a.attname <> 'guild_id') AS key
					FROM information_schema.columns c
					JOIN information_schema.tables t
						ON t.table_schema = c.table_schema AND t.table_name = c.table_name
					WHERE c.table_schema = current_schema() AND c.column_name = 'guild_id'
						AND t.table_type = 'BASE TABLE' AND c.table_name NOT LIKE 'discord\\_%'
					ORDER BY c.table_name`;
				for (const { table, key } of tables) {
					const channels = CHANNEL_TABLES.has(table);
					if (options.clearChannels && channels)
						await tx.unsafe(
							`UPDATE "${table}" SET channel_id = NULL WHERE guild_id = $1 AND channel_id IS NOT NULL`,
							[options.to],
						);
					const match = (key ?? [])
						.map((column) => `l."${column}" = t."${column}"`)
						.join(" AND ");
					// One former id at a time, in the listed order: the first to hold a key wins, and the
					// later ones find it taken.
					for (const id of from) {
						const taken = match
							? ` AND NOT EXISTS (SELECT 1 FROM "${table}" l WHERE l.guild_id = $1 AND ${match})`
							: "";
						const clear =
							channels &&
							(options.clearChannels ||
								(options.discordGuild !== undefined &&
									id !== options.discordGuild))
								? ", channel_id = NULL"
								: "";
						await tx.unsafe(
							`UPDATE "${table}" t SET guild_id = $1${clear} WHERE t.guild_id = $2${taken}`,
							[options.to, id],
						);
					}
					if (!match || from.length === 0) continue;
					const kept: Record<string, unknown>[] = await tx.unsafe(
						`SELECT t.guild_id, ${key?.map((column) => `t."${column}"`).join(", ")} FROM "${table}" t
							WHERE t.guild_id = ANY ($2::text[])
								AND EXISTS (SELECT 1 FROM "${table}" l WHERE l.guild_id = $1 AND ${match})`,
						[options.to, from],
					);
					if (kept.length > 0)
						console.warn(
							`team-move: ${kept.length} row(s) of "${table}" stay under their former id, because team "${options.to}" already holds the same key: ${kept
								.map(
									({ guild_id, ...rest }) =>
										`${guild_id}/${Object.values(rest).join("/")}`,
								)
								.join(", ")}`,
						);
				}
			}),
	};
}
