import type { SQL } from "bun";
import { parseChannelKey } from "../contract/surface.ts";
import type { ChannelKey } from "../domain/conversation.ts";

/**
 * The surface whose places `agents.channel_id` and `agent_groups.channel_id` hold: those columns
 * always kept a Discord channel or thread id. Named here once, outside the team directories, so the
 * team code stays free of it. Until 1.0 the store writes the columns and the `agent_places` rows of
 * this surface together, and every boot makes the rows equal the columns again.
 */
export const LEGACY_CHANNEL_SURFACE = "discord";

/** The id a legacy column holds for a key of the legacy surface; undefined for a key of any other surface. */
export function legacyChannelIdOf(key: ChannelKey): string | undefined {
	const { surface, id } = parseChannelKey(key);
	return surface === LEGACY_CHANNEL_SURFACE ? id : undefined;
}

/**
 * Sets the legacy `channel_id` of one agent or group of a team, or clears it with null; the other
 * columns stay. Returns the row it wrote, as the store reads it, or none for a name the team does
 * not have.
 */
export function setLegacyChannel(
	sql: SQL,
	kind: (typeof LEGACY_CHANNEL_TABLES)[keyof typeof LEGACY_CHANNEL_TABLES],
	teamId: string,
	name: string,
	channelId: string | null,
): Promise<unknown[]> {
	return kind === "agent"
		? sql`
			UPDATE agents SET channel_id = ${channelId}, updated_at = now()
			WHERE guild_id = ${teamId} AND name = ${name}
			RETURNING *`
		: sql`
			UPDATE agent_groups SET channel_id = ${channelId}
			WHERE guild_id = ${teamId} AND name = ${name}
			RETURNING *`;
}

/** The tables whose `channel_id` column is a legacy channel, and the kind of place owner each row is. */
export const LEGACY_CHANNEL_TABLES = {
	agents: "agent",
	agent_groups: "group",
} as const;

/** Serializes concurrent boots of the convergence; the key of the ledger's lock for this id. */
const LOCK = "pi-roundtable:migration:agent-server/agent-places-from-channels";

interface WantedPlace {
	kind: string;
	name: string;
	external_id: string;
}

/**
 * The warning for an owner whose channel id another owner of its team holds already: a place id
 * belongs to one owner, so no place row is made for the second, and its column stays as it is.
 */
export function warnSharedChannel(
	team: string,
	owner: { kind: string; name: string },
	channelId: string,
	holder: { kind: string; name: string } | undefined,
): void {
	console.warn(
		`agent-places: ${owner.kind} "${owner.name}" of team "${team}" holds channel ${channelId}, which ${holder?.kind} "${holder?.name}" holds already; no place row is made for it`,
	);
}

/**
 * Makes the legacy-surface rows of `agent_places` of one team equal the legacy columns of that
 * team: inserts each non-null `channel_id` as `(team, kind, name, surface, channel_id)`, and
 * deletes a row whose column is now null or different, as after a rollback to a build that wrote
 * only the columns. It reads and writes the rows of `teamId` only, so hosts of several teams over
 * one database never delete each other's rows, and a record that stays under a former id, which
 * `moveTeam` could not move, gets no row. Idempotent, in one transaction under an advisory lock. A
 * channel id that two owners of the team hold stays with the owner that has the row already, or
 * else with the first by kind then name, and the other is skipped with a warning naming both.
 */
export function convergeLegacyChannelPlaces(
	teamId: string,
): (sql: SQL) => Promise<void> {
	const wanted = Object.entries(LEGACY_CHANNEL_TABLES)
		.map(
			([table, kind]) =>
				`SELECT '${kind}' AS kind, name, channel_id AS external_id FROM ${table} WHERE guild_id = $2 AND channel_id IS NOT NULL`,
		)
		.join(" UNION ALL ");
	return (sql) =>
		sql.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(hashtextextended(${LOCK}, 0))`;
			await tx.unsafe(
				`DELETE FROM agent_places p
					WHERE p.surface = $1 AND p.team_id = $2 AND NOT EXISTS (
						SELECT 1 FROM (${wanted}) w
						WHERE w.kind = p.kind AND w.name = p.name AND w.external_id = p.external_id)`,
				[LEGACY_CHANNEL_SURFACE, teamId],
			);
			const missing: WantedPlace[] = await tx.unsafe(
				`SELECT w.kind, w.name, w.external_id FROM (${wanted}) w
					WHERE NOT EXISTS (
						SELECT 1 FROM agent_places p
						WHERE p.surface = $1 AND p.team_id = $2 AND p.kind = w.kind AND p.name = w.name)
					ORDER BY w.kind, w.name`,
				[LEGACY_CHANNEL_SURFACE, teamId],
			);
			for (const place of missing) {
				const inserted = await tx`
					INSERT INTO agent_places (team_id, kind, name, surface, external_id)
					VALUES (${teamId}, ${place.kind}, ${place.name}, ${LEGACY_CHANNEL_SURFACE}, ${place.external_id})
					ON CONFLICT DO NOTHING
					RETURNING 1`;
				if (inserted.length > 0) continue;
				const [holder]: { kind: string; name: string }[] = await tx`
					SELECT kind, name FROM agent_places
					WHERE team_id = ${teamId} AND surface = ${LEGACY_CHANNEL_SURFACE}
						AND external_id = ${place.external_id}`;
				warnSharedChannel(teamId, place, place.external_id, holder);
			}
		});
}
