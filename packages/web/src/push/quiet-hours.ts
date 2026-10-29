/** A window of the day with no push for an agent's post or a notice, as the option gives it. */
export interface QuietWindow {
	/** `HH:MM` on a 24-hour clock, where the window begins. */
	start: string;
	/** `HH:MM` on a 24-hour clock, where the window ends; before `start` when it crosses midnight. */
	end: string;
}

/** What the option holds when it is not set: pushes rest from 23:00 to 08:00. */
export const DEFAULT_QUIET_HOURS: QuietWindow = {
	start: "23:00",
	end: "08:00",
};

/** The minutes after midnight of an `HH:MM` time on a 24-hour clock; undefined for any other text. */
export function minutesOfDay(text: string): number | undefined {
	const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
	return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

/**
 * Tells whether a moment falls in a quiet window on the wall clock of a time zone. The zone's
 * clock is read through `Intl`, so its daylight-saving changes are followed with no offset table
 * of ours; a window is half open, quiet from `start` up to but not including `end`.
 */
export class QuietClock {
	readonly #start: number;
	readonly #end: number;
	readonly #format: Intl.DateTimeFormat;

	/** Throws a `RangeError` for a time zone `Intl` does not know and a `TypeError` for a bad time. */
	constructor(window: QuietWindow, timeZone: string) {
		const start = minutesOfDay(window.start);
		const end = minutesOfDay(window.end);
		if (start === undefined || end === undefined || start === end)
			throw new TypeError(
				`quiet hours need two different times as HH:MM, not ${window.start} and ${window.end}`,
			);
		this.#start = start;
		this.#end = end;
		this.#format = new Intl.DateTimeFormat("en-GB", {
			timeZone,
			hourCycle: "h23",
			hour: "2-digit",
			minute: "2-digit",
		});
	}

	/** Whether the moment, in milliseconds since the epoch, is inside the window. */
	quietAt(ms: number): boolean {
		const parts = this.#format.formatToParts(ms);
		const part = (type: string): number =>
			Number(parts.find((candidate) => candidate.type === type)?.value);
		// Some engines still write midnight as hour 24 under `h23`; the remainder folds it back to 0.
		const minute = (part("hour") % 24) * 60 + part("minute");
		return this.#start < this.#end
			? minute >= this.#start && minute < this.#end
			: minute >= this.#start || minute < this.#end;
	}
}
