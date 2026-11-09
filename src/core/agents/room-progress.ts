import type { ChannelKey } from "../domain/conversation.ts";
import type { TurnProgress } from "../domain/progress.ts";
import type { TeamTurnsOptions } from "./team-turn-types.ts";

/**
 * What a turn in a room shows as it goes, through the room's surface; none in a stored place,
 * such as a Discord channel, which shows only the final reply, or on a surface that shows no progress.
 */
export function roomProgress(
	{
		surfaces,
		places,
		logger,
	}: Pick<TeamTurnsOptions, "surfaces" | "places" | "logger">,
	channel: ChannelKey,
): ((event: TurnProgress) => void) | undefined {
	if (places.isStored(channel) || !surfaces?.progress) return undefined;
	return (event) => {
		// pi-lens-ignore: no-unknown-parameters — a rejection reason is unknown; it only reaches the logger
		surfaces
			.progress?.(channel, event)
			.catch((error: unknown) =>
				logger.warn({ channel, err: error }, "progress not shown"),
			);
	};
}
