import { list, optional, orOff, shape, text } from "./schema.ts";

/** The `skills` setting when the addon is on. */
export interface SkillsConfig {
	/** Where the registry reads the release's built-in skills. */
	builtinDir?: string;
	/** Where it keeps linked repositories; default `<dataDir>/repos`. */
	reposDir?: string;
	/**
	 * npm packages the host installed. Every skill in their `pi.skills` folders is offered
	 * read-only, and carried and grouped like any other. Startup fails, naming the fix, when a
	 * package is not installed, ships no skills, or holds a skill whose name another skill has.
	 */
	packages?: string[];
}

export const skillsField = orOff(
	shape({
		builtinDir: optional(text),
		reposDir: optional(text),
		packages: optional(list(text)),
	}),
);
