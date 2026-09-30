import { fail, ok, type Result } from "../report.ts";

export const BUN_INSTALL_PAGE = "https://bun.sh/docs/installation";

/** What the command line knows about the Bun it runs on and the one the package needs. */
export interface BunFacts {
	/** The running Bun's version; undefined when there is none. */
	version: string | undefined;
	/** The package's `engines.bun` range. */
	required: string;
}

/** Bun's version against the package's range; both `init` and `doctor` refuse on the same words. */
export function checkBun({ version, required }: BunFacts): Result {
	if (version === undefined)
		return fail(
			"Bun is not installed.",
			`pi-roundtable runs on Bun ${required}. Install it from ${BUN_INSTALL_PAGE} and run the command again.`,
		);
	if (!Bun.semver.satisfies(version, required))
		return fail(
			`Bun ${version} is older than the ${required} this package needs.`,
			`Upgrade with \`bun upgrade\` (see ${BUN_INSTALL_PAGE}) and run the command again.`,
		);
	return ok(`Bun ${version}`);
}
