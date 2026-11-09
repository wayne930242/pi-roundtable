import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { PluginError } from "pi-roundtable";
import { within } from "pi-roundtable/kit";
import { ROOT_ID, type WorkspaceRoot } from "./workspace-model.ts";

/** The real directory of a path that may not exist: its nearest existing ancestor, resolved, plus the rest. */
export function realish(path: string): string {
	const rest: string[] = [];
	let current = resolve(path);
	for (;;) {
		try {
			return join(realpathSync(current), ...rest.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return resolve(path);
			rest.push(basename(current));
			current = parent;
		}
	}
}

/**
 * Checks the roots a host configured, once at the start: each id a short lower-case word and
 * given once, each directory absolute, and none of them the host's data directory or a directory
 * that contains it (that holds the sessions, keys and credentials), symlinks resolved.
 */
export function checkRoots(
	roots: readonly WorkspaceRoot[],
	protectedDirs: readonly string[],
): void {
	const seen = new Set<string>();
	const guarded = protectedDirs.map(realish);
	for (const root of roots) {
		if (!ROOT_ID.test(root.id))
			throw new PluginError(
				`pi-roundtable-web: workspace root id ${JSON.stringify(root.id)} must be a lower-case word such as agents`,
			);
		if (seen.has(root.id))
			throw new PluginError(
				`pi-roundtable-web: workspace root id ${root.id} is used twice`,
			);
		seen.add(root.id);
		if (!isAbsolute(root.dir))
			throw new PluginError(
				`pi-roundtable-web: workspace root ${root.id} must be an absolute directory, not ${JSON.stringify(root.dir)}`,
			);
		const real = realish(root.dir);
		for (const dir of guarded) {
			if (real === dir)
				throw new PluginError(
					`pi-roundtable-web: workspace root ${root.id} is ${dir}, which holds the host's data and keys; choose a directory inside it or beside it`,
				);
			if (within(real, dir))
				throw new PluginError(
					`pi-roundtable-web: workspace root ${root.id} (${real}) contains ${dir}, which holds the host's data and keys; choose a narrower directory`,
				);
		}
	}
}
