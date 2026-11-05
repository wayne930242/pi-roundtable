/** The host chooses one IANA zone before starting its services. */
let zone = "UTC";

export function setTimeZone(value: string): void {
	try {
		new Intl.DateTimeFormat("sv-SE", { timeZone: value });
	} catch {
		throw new Error(`Invalid time zone: ${value}`);
	}
	zone = value;
}

export function timeZone(): string {
	return zone;
}

/** The formatter is constructed when used, not at import time, so configuration is observed. */
function stamp(at: Date): string {
	return zonedStampIn(at, zone);
}

/** `at` as "YYYY-MM-DD HH:MM" in the named IANA time zone, whatever the host chose. */
export function zonedStampIn(at: Date, timeZone: string): string {
	return new Intl.DateTimeFormat("sv-SE", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).format(at);
}

export function zonedDate(at: Date): string {
	return stamp(at).slice(0, 10);
}

export function zonedStamp(at: Date): string {
	return stamp(at);
}

export function zonedToday(): string {
	return zonedDate(new Date());
}

/** Convert a local minute to an instant. Choose the first occurrence in a fold and
 * a later valid wall time in a gap (e.g. 02:30 becomes 03:30).
 * Probe both sides of a transition: a single offset iteration can oscillate in a gap.
 */
export function zonedInstant(date: string, time: string): Date {
	const wall = `${date} ${time}`;
	const utc = Date.parse(`${date}T${time}:00Z`);
	const minute = 60_000;
	const offsets = new Set<number>();
	for (const delta of [-86_400_000, 0, 86_400_000]) {
		const probe = utc + delta;
		const local = stamp(new Date(probe));
		const localAsUtc = Date.parse(`${local.replace(" ", "T")}:00Z`);
		offsets.add(localAsUtc - Math.floor(probe / minute) * minute);
	}
	const candidates = [...offsets]
		.map((offset) => new Date(utc - offset))
		.sort((a, b) => a.getTime() - b.getTime());
	const fallback = candidates.at(-1);
	if (!fallback) throw new Error(`Could not resolve local time: ${wall}`);
	return (
		candidates.find((candidate) => stamp(candidate) === wall) ??
		candidates.find((candidate) => stamp(candidate) > wall) ??
		fallback
	);
}
