import { list, optional, shape, text } from "./schema.ts";

/**
 * The team's identity in the database, independent of any Discord guild. `id` is what the rows the
 * team keeps (agents, groups, skills, prompts, presets) are stored under; default the id of
 * `discord.guild`, else `"local"`. `formerIds` are the ids the team was stored under before, such
 * as a guild it left: their rows move to `id` at every boot (a row the team already holds stays),
 * and without Discord channels lose the channel ids they carried.
 */
export interface TeamConfig {
	id?: string;
	formerIds?: string[];
}

/** What the host reads: `id` is left out when the Discord guild or the local team gives it. */
export interface ResolvedTeam {
	id?: string;
	formerIds: readonly string[];
}

export const teamField = optional(
	shape({ id: optional(text), formerIds: optional(list(text)) }),
);

export function teamOf(team: TeamConfig | undefined): ResolvedTeam {
	return {
		...(team?.id === undefined ? {} : { id: team.id }),
		formerIds: team?.formerIds ?? [],
	};
}
