import { createRequire } from "node:module";
import { dirname } from "node:path";

/**
 * The installed package's folder, as Pi's `additionalExtensionPaths` takes it. The package is
 * looked up from `from`, which is `import.meta.url` of the module that asks, so a host finds its
 * own dependencies even when `pi-roundtable` is linked or installed apart from them; without it
 * the lookup starts at the core's own files.
 */
export function packageDir(name: string, from: string | URL = import.meta.url) {
	return dirname(createRequire(from).resolve(`${name}/package.json`));
}
