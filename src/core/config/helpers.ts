import { ConfigError } from "../domain/errors.ts";
import { type Field, integer, optional, orOff, shape } from "./schema.ts";

/**
 * Temp knights: helper knights an agent makes for a task and clears when they are done. Left out,
 * the defaults below apply; `false` stops the tools `helper_create` and `helper_end` being offered.
 */
export interface HelpersConfig {
	/** The most active temp knights one knight has at once, 1 to 8; default 4. */
	perParent?: number;
	/** The most active temp knights on the whole host, 1 to 50; default 12. */
	perHost?: number;
	/**
	 * Hours a finished temp knight stays before the host archives it, 1 to 720; `false` never does.
	 * Default 24. An archived one can be restored from the archive page.
	 */
	archiveFinishedAfterHours?: number | false;
}

/** What the team reads: every limit filled in. */
export interface ResolvedHelpers {
	perParent: number;
	perHost: number;
	archiveFinishedAfterHours: number | false;
}

const DEFAULT_HELPERS: ResolvedHelpers = Object.freeze({
	perParent: 4,
	perHost: 12,
	archiveFinishedAfterHours: 24,
});

const afterHours: Field<number | false> = orOff(integer(1, 720));

export const helpersField = orOff(
	shape({
		perParent: optional(integer(1, 8)),
		perHost: optional(integer(1, 50)),
		archiveFinishedAfterHours: optional(afterHours),
	}),
);

/** The checked `helpers` block with the defaults filled in; `false` when it is switched off. */
export function helpersOf(
	config: HelpersConfig | false | undefined,
): ResolvedHelpers | false {
	if (config === false) return false;
	const resolved: ResolvedHelpers = {
		perParent: config?.perParent ?? DEFAULT_HELPERS.perParent,
		perHost: config?.perHost ?? DEFAULT_HELPERS.perHost,
		archiveFinishedAfterHours:
			config?.archiveFinishedAfterHours ??
			DEFAULT_HELPERS.archiveFinishedAfterHours,
	};
	if (resolved.perParent > resolved.perHost)
		throw new ConfigError(
			`config helpers.perParent: ${resolved.perParent} is more than helpers.perHost (${resolved.perHost}), which counts all of them. Lower perParent or raise perHost.`,
		);
	return resolved;
}
