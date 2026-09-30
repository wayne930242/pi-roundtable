import { ScheduleError } from "../../domain/errors.ts";
import { messages } from "../../i18n/index.ts";
import { timeZone, zonedDate, zonedInstant, zonedStamp } from "../../time.ts";

export const WEEKDAYS = [
	"sun",
	"mon",
	"tue",
	"wed",
	"thu",
	"fri",
	"sat",
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** When a schedule runs, in the configured wall-clock time. */
export type Recurrence =
	| { kind: "once"; date: string; time: string; instant?: string }
	| { kind: "every"; time: string; everyDays: number; startDate: string }
	| { kind: "weekly"; time: string; weekdays: Weekday[] };

const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function dayIndex(date: string): number {
	return Date.parse(`${date}T00:00:00Z`) / DAY_MS;
}

function addDays(date: string, days: number): string {
	return new Date((dayIndex(date) + days) * DAY_MS).toISOString().slice(0, 10);
}

function weekday(date: string): Weekday {
	return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? "sun";
}

/** The first run strictly after `after`, or undefined when a one-time schedule has passed. */
export function nextRun(recurrence: Recurrence, after: Date): Date | undefined {
	switch (recurrence.kind) {
		case "once": {
			const at = recurrence.instant
				? new Date(recurrence.instant)
				: zonedInstant(recurrence.date, recurrence.time);
			return at > after ? at : undefined;
		}
		case "every": {
			const { startDate, everyDays, time } = recurrence;
			const behind = dayIndex(zonedDate(after)) - dayIndex(startDate);
			let step = Math.max(0, Math.ceil(behind / everyDays));
			for (;;) {
				const at = zonedInstant(addDays(startDate, step * everyDays), time);
				if (at > after) return at;
				step += 1;
			}
		}
		case "weekly": {
			const today = zonedDate(after);
			for (let offset = 0; offset <= 7; offset += 1) {
				const date = addDays(today, offset);
				if (!recurrence.weekdays.includes(weekday(date))) continue;
				const at = zonedInstant(date, recurrence.time);
				if (at > after) return at;
			}
			throw new ScheduleError("a weekly schedule needs at least one weekday");
		}
		default:
			throw new ScheduleError("unknown recurrence kind");
	}
}

/** The recurrence in the owner's words, for tool answers and panels. */
export function describeRecurrence(recurrence: Recurrence): string {
	const text = messages();
	switch (recurrence.kind) {
		case "once":
			return text.scheduleOnce(recurrence.date, recurrence.time);
		case "every":
			return recurrence.everyDays === 1
				? text.scheduleDaily(recurrence.time)
				: text.scheduleEveryDays(
						recurrence.everyDays,
						recurrence.time,
						recurrence.startDate,
					);
		case "weekly":
			return text.scheduleWeekly(
				recurrence.weekdays.map((d) => text.scheduleWeekday(d)),
				recurrence.time,
			);
		default:
			throw new ScheduleError("unknown recurrence kind");
	}
}

export interface RecurrenceInput {
	in_minutes?: unknown;
	at?: unknown;
	time?: unknown;
	every_days?: unknown;
	start_date?: unknown;
	weekdays?: unknown;
}

function validDate(value: string): boolean {
	return (
		DATE.test(value) &&
		new Date(`${value}T00:00:00Z`).toISOString().startsWith(value)
	);
}

const MAX_MINUTES = 366 * 24 * 60;

/**
 * Reads the tool fields that set timing: `in_minutes` or `at` for one run, or `time` with either
 * `every_days` (and an optional `start_date`) or `weekdays`. Throws ScheduleError with a
 * message the model can act on.
 */
export function parseRecurrence(input: RecurrenceInput, now: Date): Recurrence {
	const { in_minutes, at, time, every_days, start_date, weekdays } = input;
	if (in_minutes !== undefined) {
		if (
			[at, time, every_days, start_date, weekdays].some((v) => v !== undefined)
		)
			throw new ScheduleError(
				"in_minutes sets one run on its own; do not combine it with other timing",
			);
		if (
			typeof in_minutes !== "number" ||
			!Number.isInteger(in_minutes) ||
			in_minutes < 1 ||
			in_minutes > MAX_MINUTES
		)
			throw new ScheduleError(
				"in_minutes must be a whole number of minutes, at least 1",
			);
		// Rounded up to the minute, so the run is never earlier than asked.
		const target = new Date(
			Math.ceil((now.getTime() + in_minutes * 60_000) / 60_000) * 60_000,
		);
		const [date = "", clock = ""] = zonedStamp(target).split(" ");
		// A relative request in the second occurrence of a fall-back hour must not
		// silently move to the first occurrence of that same wall-clock minute.
		const first = zonedInstant(date, clock);
		return first.getTime() === target.getTime()
			? { kind: "once", date, time: clock }
			: { kind: "once", date, time: clock, instant: target.toISOString() };
	}
	if (at !== undefined) {
		if (
			time !== undefined ||
			every_days !== undefined ||
			weekdays !== undefined
		)
			throw new ScheduleError(
				"give either at (one run) or time (repeating), not both",
			);
		const match =
			typeof at === "string"
				? /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/.exec(at.trim())
				: null;
		const [, date = "", clock = ""] = match ?? [];
		if (!match || !validDate(date) || !TIME.test(clock))
			throw new ScheduleError(messages().atTimeError(timeZone()));
		return { kind: "once", date, time: clock };
	}
	if (typeof time !== "string" || !TIME.test(time.trim()))
		throw new ScheduleError(messages().repeatingTimeError(timeZone()));
	const clock = time.trim();
	if (weekdays !== undefined) {
		if (every_days !== undefined || start_date !== undefined)
			throw new ScheduleError(
				"weekdays cannot be combined with every_days or start_date",
			);
		const days = Array.isArray(weekdays)
			? weekdays.map((d) => String(d).trim().toLowerCase().slice(0, 3))
			: [];
		if (
			days.length === 0 ||
			!days.every((d): d is Weekday =>
				(WEEKDAYS as readonly string[]).includes(d),
			)
		)
			throw new ScheduleError(
				`weekdays must be a list of ${WEEKDAYS.join(", ")}`,
			);
		return {
			kind: "weekly",
			time: clock,
			weekdays: WEEKDAYS.filter((d) => days.includes(d)),
		};
	}
	const everyDays = every_days === undefined ? 1 : every_days;
	if (
		typeof everyDays !== "number" ||
		!Number.isInteger(everyDays) ||
		everyDays < 1 ||
		everyDays > 365
	)
		throw new ScheduleError("every_days must be a whole number from 1 to 365");
	const startDate =
		start_date === undefined ? zonedDate(now) : String(start_date).trim();
	if (!validDate(startDate))
		throw new ScheduleError('start_date must be "YYYY-MM-DD"');
	return { kind: "every", time: clock, everyDays, startDate };
}
