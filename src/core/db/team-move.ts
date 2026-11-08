import type { Migration } from "./migrations.ts";

export interface TeamMoveOptions {
	/** The ids the team was stored under before, such as a Discord guild it no longer lives in. */
	from: readonly string[];
	/** The team's id now. */
	to: string;
	/**
	 * Clear the Discord channel id of each agent and group it moves, for a team that has no Discord
	 * channels: an id left from the old guild names a channel that is gone. Default false.
	 */
	clearChannels?: boolean;
}

/** The tables whose rows hold a Discord channel id. */
const CHANNEL_TABLES = new Set(["agents", "agent_groups"]);

/**
 * Moves a former team's rows to the team id: every row of a table with a `guild_id` column whose id
 * is one of `from`, in the tables the host's plugins keep (agents, groups, skills, prompts, presets,
 * outbox, conversations). Rows of other guilds stay, such as the `discord_*` grants and audit of the
 * guilds a bot still serves. A row whose key the team already holds stays where it is, so a second
 * boot changes nothing.
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
				if (from.length === 0) return;
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
					const taken = key?.length
						? ` AND NOT EXISTS (SELECT 1 FROM "${table}" l WHERE l.guild_id = $1 AND ${key
								.map((column) => `l."${column}" = t."${column}"`)
								.join(" AND ")})`
						: "";
					const clear =
						options.clearChannels && CHANNEL_TABLES.has(table)
							? ", channel_id = NULL"
							: "";
					await tx.unsafe(
						`UPDATE "${table}" t SET guild_id = $1${clear} WHERE t.guild_id = ANY ($2::text[])${taken}`,
						[options.to, from],
					);
				}
			}),
	};
}
