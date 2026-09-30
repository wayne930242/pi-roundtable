import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);

/** The installed package's folder, as Pi's `additionalExtensionPaths` takes it. */
export function packageDir(name: string): string {
	return dirname(require.resolve(`${name}/package.json`));
}
