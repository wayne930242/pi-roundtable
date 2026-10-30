import { ScheduleError } from "../../domain/errors.ts";
import { MAX_SCHEDULE_TIME_LIMIT_MINUTES } from "../../shared/schedule-tools.ts";

/**
 * A schedule's time limit from a tool's input: undefined when it names none, null when it asks
 * for the runtime's default again, else whole minutes within the schedule limit's maximum.
 */
export function timeLimitInput(value: unknown): number | null | undefined {
	if (value === undefined || value === null) return value;
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 1 ||
		value > MAX_SCHEDULE_TIME_LIMIT_MINUTES
	)
		throw new ScheduleError(
			`time_limit_minutes must be a whole number of minutes from 1 to ${MAX_SCHEDULE_TIME_LIMIT_MINUTES}`,
		);
	return value;
}

/** The time limit as the schedule's lines and replies say it; empty for the default. */
export function timeLimitText(minutes: number | undefined): string {
	return minutes === undefined
		? ""
		: `; each run may work up to ${minutes} min`;
}
