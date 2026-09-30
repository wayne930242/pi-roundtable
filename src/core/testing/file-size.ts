import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/** The most lines a source file may have before it is split along its responsibilities. */
export const MAX_SOURCE_LINES = 500;
/** The most lines a test file may have. */
export const MAX_TEST_LINES = 700;

function typeScriptFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		if (entry.name === "node_modules") return [];
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return typeScriptFiles(path);
		return /\.tsx?$/.test(entry.name) ? [path] : [];
	});
}

/** The files under `dirs` over their limit, each as `<path> has <n> lines`. */
export function oversizedFiles(
	root: string,
	dirs: readonly string[],
): string[] {
	return dirs
		.flatMap((dir) => typeScriptFiles(join(root, dir)))
		.flatMap((file) => {
			const lines = readFileSync(file, "utf8").split("\n").length - 1;
			const limit = /\.test\.tsx?$/.test(file)
				? MAX_TEST_LINES
				: MAX_SOURCE_LINES;
			return lines > limit
				? [`${relative(root, file)} has ${lines} lines, over ${limit}`]
				: [];
		});
}
