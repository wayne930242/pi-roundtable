import type { SQL } from "bun";

/**
 * The surface whose places `agents.channel_id` and `agent_groups.channel_id` hold: those columns
 * always kept a Discord channel or thread id. Named here once, outside the team directories, so the
 * team code stays free of it. Until 1.0 the store writes the columns and the `agent_places` rows of
 * this surface together, and every boot makes the rows equal the columns again.
 */
export const LEGACY_CHANNEL_SURFACE = "discord";

/** The tables whose `channel_id` column is a legacy channel, and the kind of place owner each row is. */
export const LEGACY_CHANNEL_TABLES = {
	agents: "agent",
	agent_groups: "group",
} as const;

/** Serializes concurrent boots of the convergence; the key of the ledger's lock for this id. */
const LOCK = "pi-roundtable:migration:agent-server/agent-places-from-channels";

interface WantedPlace {
	team_id: string;
	kind: string;
	name: string;
	external_id: string;
}

/**
 * Makes the legacy-surface rows of `agent_places` equal the legacy columns of every team in the
 * database: inserts each non-null `channel_id` as `(team, kind, name, surface, channel_id)`, and
 * deletes a row whose column is now null or different, as after a rollback to a build that wrote
 * only the columns. Idempotent, in one transaction under an advisory lock. A channel id that two
 * owners of one team hold stays with the first (kind, then name) and the other is skipped with a
 * warning naming both.
 */
export async function convergeLegacyChannelPlaces(sql: SQL): Promise<void> {
	const wanted = Object.entries(LEGACY_CHANNEL_TABLES)
		.map(
			([table, kind]) =>
				`SELECT guild_id AS team_id, '${kind}' AS kind, name, channel_id AS external_id FROM ${table} WHERE channel_id IS NOT NULL`,
		)
		.join(" UNION ALL ");
	await sql.begin(async (tx) => {
		await tx`SELECT pg_advisory_xact_lock(hashtextextended(${LOCK}, 0))`;
		await tx.unsafe(
			`DELETE FROM agent_places p
				WHERE p.surface = $1 AND NOT EXISTS (
					SELECT 1 FROM (${wanted}) w
					WHERE w.team_id = p.team_id AND w.kind = p.kind AND w.name = p.name
						AND w.external_id = p.external_id)`,
			[LEGACY_CHANNEL_SURFACE],
		);
		const missing: WantedPlace[] = await tx.unsafe(
			`SELECT w.team_id, w.kind, w.name, w.external_id FROM (${wanted}) w
				WHERE NOT EXISTS (
					SELECT 1 FROM agent_places p
					WHERE p.surface = $1 AND p.team_id = w.team_id AND p.kind = w.kind AND p.name = w.name)
				ORDER BY w.team_id, w.kind, w.name`,
			[LEGACY_CHANNEL_SURFACE],
		);
		for (const place of missing) {
			const inserted = await tx`
				INSERT INTO agent_places (team_id, kind, name, surface, external_id)
				VALUES (${place.team_id}, ${place.kind}, ${place.name}, ${LEGACY_CHANNEL_SURFACE}, ${place.external_id})
				ON CONFLICT DO NOTHING
				RETURNING 1`;
			if (inserted.length > 0) continue;
			const [holder]: { kind: string; name: string }[] = await tx`
				SELECT kind, name FROM agent_places
				WHERE team_id = ${place.team_id} AND surface = ${LEGACY_CHANNEL_SURFACE}
					AND external_id = ${place.external_id}`;
			console.warn(
				`agent-places-from-channels: ${place.kind} "${place.name}" of team "${place.team_id}" holds channel ${place.external_id}, which ${holder?.kind} "${holder?.name}" holds already; no place row is made for it`,
			);
		}
	});
}
