import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/** The most lines a source file may have before it is split along its responsibilities. */
export const MAX_SOURCE_LINES = 500;
/** The most lines a test file may have. */
export const MAX_TEST_LINES = 700;

/** The directories the limit covers: the core, its command line and entries, and every workspace package. */
export const SIZED_DIRS: readonly string[] = [
	"src",
	"packages",
	"scripts",
	"examples",
];

/** The TypeScript files under `dir`, skipping installed and built output. */
function typeScriptFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		if (entry.name.startsWith(".")) return [];
		const path = join(dir, entry.name);
		if (entry.isDirectory())
			return entry.name === "node_modules" || entry.name === "dist"
				? []
				: typeScriptFiles(path);
		return /\.tsx?$/.test(entry.name) ? [path] : [];
	});
}

/** The files under `dirs` over their limit, by path relative to `root`, with their line counts. */
export function oversizedFiles(
	root: string,
	dirs: readonly string[] = SIZED_DIRS,
): Record<string, number> {
	const found: [string, number][] = dirs.flatMap((dir) =>
		typeScriptFiles(join(root, dir)).flatMap((file): [string, number][] => {
			const lines = readFileSync(file, "utf8").split("\n").length - 1;
			const limit = /\.test\.tsx?$/.test(file)
				? MAX_TEST_LINES
				: MAX_SOURCE_LINES;
			const path = relative(root, file).split(sep).join("/");
			return lines > limit ? [[path, lines]] : [];
		}),
	);
	return Object.fromEntries(found.sort(([a], [b]) => a.localeCompare(b)));
}

if (import.meta.main) {
	const root = resolve(process.argv[2] ?? ".");
	// pi-lens-ignore: no-console-except-error — the script's printed report is its product
	console.log(JSON.stringify(oversizedFiles(root), null, "\t"));
}
