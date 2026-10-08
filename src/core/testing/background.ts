import type { BackgroundRunsAs, BackgroundTurn } from "../contract/channels.ts";
import type { Schedule } from "../modules/schedules/schedule-store.ts";

/** A conversation port's `runsAs` for tests: every turn runs as its author, at its own tier. */
export async function runsAsAuthor(
	turn: BackgroundTurn,
): Promise<BackgroundRunsAs> {
	const { author, tier } = turn;
	return {
		speaker: {
			id: author.id,
			name: author.name,
			tier,
			principalId: author.principalId,
		},
	};
}

/** A scheduled runner's `runsAs` for tests: every schedule runs as its creator, at the tier it was set at. */
export async function runsAsCreator(
	schedule: Schedule,
): Promise<BackgroundRunsAs> {
	return {
		speaker: {
			id: schedule.createdById,
			name: schedule.createdByName,
			tier: schedule.createdTier,
			principalId: schedule.createdById,
		},
	};
}
