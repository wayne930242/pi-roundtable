import type { SQL } from "bun";
import type { Migration } from "pi-roundtable";
import { minutesOfDay, QuietClock, type QuietWindow } from "./quiet-hours.ts";

/** A person's own quiet hours: no push for a normal notice in the window, on their time zone's clock. */
export interface PushPrefs {
	/** `HH:MM`, where the window begins. */
	quietStart: string;
	/** `HH:MM`, where it ends; before `start` when it crosses midnight. */
	quietEnd: string;
	/** The IANA zone the times are read in. */
	timeZone: string;
}

interface Row {
	quiet_start: string;
	quiet_end: string;
	time_zone: string;
}

/** Why a preference was refused, in words the page shows. */
export class PrefsRefused extends Error {}

/** Checks the three fields; throws `PrefsRefused` for a time that is not `HH:MM`, equal times or an unknown zone. */
export function checkPrefs(value: unknown): PushPrefs {
	const given = value as Partial<PushPrefs> | null;
	if (
		typeof given !== "object" ||
		given === null ||
		typeof given.quietStart !== "string" ||
		typeof given.quietEnd !== "string" ||
		typeof given.timeZone !== "string"
	)
		throw new PrefsRefused(
			"Quiet hours need quietStart, quietEnd and timeZone.",
		);
	if (
		minutesOfDay(given.quietStart) === undefined ||
		minutesOfDay(given.quietEnd) === undefined
	)
		throw new PrefsRefused("Quiet hours are times like 22:00 and 07:30.");
	if (given.quietStart === given.quietEnd)
		throw new PrefsRefused("The two times of the quiet hours must differ.");
	try {
		new QuietClock(
			{ start: given.quietStart, end: given.quietEnd },
			given.timeZone,
		);
	} catch {
		throw new PrefsRefused("That time zone is not known.");
	}
	return {
		quietStart: given.quietStart,
		quietEnd: given.quietEnd,
		timeZone: given.timeZone,
	};
}

/** The people's quiet hours, in `web_push_prefs`. */
export class PushPrefsStore {
	readonly #sql: SQL;

	constructor(sql: SQL) {
		this.#sql = sql;
	}

	static readonly migration: Migration = {
		name: "web-push-prefs",
		up: async (sql) => {
			await sql`
				CREATE TABLE IF NOT EXISTS web_push_prefs (
					principal_id text PRIMARY KEY,
					quiet_start text NOT NULL,
					quiet_end text NOT NULL,
					time_zone text NOT NULL
				)`;
		},
	};

	async get(principalId: string): Promise<PushPrefs | undefined> {
		const [row]: Row[] = await this.#sql`
			SELECT quiet_start, quiet_end, time_zone FROM web_push_prefs
			WHERE principal_id = ${principalId}`;
		return row
			? {
					quietStart: row.quiet_start,
					quietEnd: row.quiet_end,
					timeZone: row.time_zone,
				}
			: undefined;
	}

	/** Stores the person's quiet hours, or removes them with `undefined`. */
	async set(principalId: string, prefs: PushPrefs | undefined): Promise<void> {
		if (!prefs) {
			await this
				.#sql`DELETE FROM web_push_prefs WHERE principal_id = ${principalId}`;
			return;
		}
		await this.#sql`
			INSERT INTO web_push_prefs (principal_id, quiet_start, quiet_end, time_zone)
			VALUES (${principalId}, ${prefs.quietStart}, ${prefs.quietEnd}, ${prefs.timeZone})
			ON CONFLICT (principal_id) DO UPDATE SET
				quiet_start = EXCLUDED.quiet_start, quiet_end = EXCLUDED.quiet_end,
				time_zone = EXCLUDED.time_zone`;
	}

	/** Whether the moment is inside the person's quiet hours; false when they set none. */
	async quietAt(principalId: string, at: number): Promise<boolean> {
		const prefs = await this.get(principalId);
		if (!prefs) return false;
		const window: QuietWindow = {
			start: prefs.quietStart,
			end: prefs.quietEnd,
		};
		return new QuietClock(window, prefs.timeZone).quietAt(at);
	}
}
