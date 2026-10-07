import {
	existsSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { resolveConfig } from "../core/config/config.ts";
import { ConfigEditError } from "./config-edit.ts";
import { lineDiff } from "./line-diff.ts";
import { CONFIG_FILE } from "./project.ts";
import { type Upgraded, upgradeSource } from "./upgrade-source.ts";

export interface UpgradeInputs {
	/** The project directory, holding roundtable.config.ts. */
	cwd: string;
	/** Write the rewrite; without it the upgrade only shows it. */
	write: boolean;
	/** The value a configuration file exports by default, loaded as the host loads it. */
	load(path: string): Promise<unknown>;
}

export type UpgradeReport =
	| {
			ok: true;
			/** The unified diff of the rewrite; empty when there is nothing to change. */
			diff: string[];
			changes: string[];
			notes: string[];
			/** Whether the rewrite was checked to serve the same people, or why it could not be. */
			verified: { same: true } | { skipped: string };
			written: boolean;
	  }
	| { ok: false; problems: string[] };

const message = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/** What the host makes of a configuration that decides whom it serves. */
function servedBy(config: unknown) {
	const resolved = resolveConfig(config);
	return {
		access: resolved.access,
		primaryOwner: resolved.primaryOwner,
		discord: resolved.discord,
	};
}

/**
 * Whether the rewrite serves the same people as the file as it is, loading it beside the file so
 * its imports resolve the same; skipped when the file as it is does not load, a problem when the
 * rewrite does not load or differs.
 */
async function compare(
	inputs: UpgradeInputs,
	path: string,
	rewritten: string,
): Promise<{ same: true } | { skipped: string } | { problem: string }> {
	// Written before either is loaded: Bun reads a directory's files once, at its first import from it.
	const candidate = join(
		inputs.cwd,
		`${CONFIG_FILE.replace(/\.ts$/, "")}.upgrade-${crypto.randomUUID()}.ts`,
	);
	writeFileSync(candidate, rewritten);
	let before: ReturnType<typeof servedBy>;
	try {
		before = servedBy(await inputs.load(path));
	} catch (error) {
		rmSync(candidate, { force: true });
		return {
			skipped: `${CONFIG_FILE} does not load as it is (${message(error)}), so the rewrite could not be compared with it`,
		};
	}
	try {
		const after = servedBy(await inputs.load(candidate));
		if (isDeepStrictEqual(before, after)) return { same: true };
		return {
			problem: `the rewrite would change whom the host serves, so it was not written: ${CONFIG_FILE} as it is gives ${JSON.stringify(before.access)}, the rewrite ${JSON.stringify(after.access)}. Rewrite owner and speakers as access by hand, and report this as a bug in roundtable upgrade.`,
		};
	} catch (error) {
		return {
			problem: `the rewrite does not load (${message(error)}), so it was not written. Rewrite owner and speakers as access by hand, and report this as a bug in roundtable upgrade.`,
		};
	} finally {
		rmSync(candidate, { force: true });
	}
}

/**
 * Rewrites the project's roundtable.config.ts in the 0.9 form, after showing it. Before it writes,
 * it loads the rewrite beside the original and refuses it unless the host would serve the same
 * people, with the same owners and Discord settings; when the original does not load, such as
 * without its `.env`, it says the check was skipped. It touches no other file.
 */
export async function upgrade(inputs: UpgradeInputs): Promise<UpgradeReport> {
	const path = join(inputs.cwd, CONFIG_FILE);
	if (!existsSync(path))
		return {
			ok: false,
			problems: [
				`${CONFIG_FILE} is not in ${inputs.cwd}. Run this in the project directory.`,
			],
		};
	const source = readFileSync(path, "utf8");
	let upgraded: Upgraded;
	try {
		upgraded = upgradeSource(source);
	} catch (error) {
		if (error instanceof ConfigEditError)
			return { ok: false, problems: [error.message] };
		throw error;
	}
	const { changes, notes } = upgraded;
	if (changes.length === 0)
		return {
			ok: true,
			diff: [],
			changes,
			notes,
			verified: { skipped: "there is nothing to change" },
			written: false,
		};
	const verified = await compare(inputs, path, upgraded.source);
	if ("problem" in verified) return { ok: false, problems: [verified.problem] };
	if (inputs.write) {
		// Written beside it and renamed over it, so the file is never half written.
		const staged = `${path}.upgrade-${crypto.randomUUID()}`;
		writeFileSync(staged, upgraded.source);
		renameSync(staged, path);
	}
	return {
		ok: true,
		diff: lineDiff(source, upgraded.source, CONFIG_FILE),
		changes,
		notes,
		verified,
		written: inputs.write,
	};
}
