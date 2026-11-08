import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A peer range as prose states it, such as `>=0.42.0 <0.43.0`. */
export const RANGE_PATTERN = /(>=\d+\.\d+\.\d+ ?<\d+\.\d+\.\d+)/g;

/** The peer range for one core version: its minor, written the way every manifest carries it. */
export function peerRange(version: string): string {
	const found = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!found) throw new Error(`Not a release version: ${version}`);
	return `>=${found[1]}.${found[2]}.0 <${found[1]}.${Number(found[2]) + 1}.0`;
}

/** The files whose prose may state a peer range, by path relative to `root`; those that do not exist are left out. */
export function docsFiles(root: string): string[] {
	const glob = (pattern: string) =>
		[...new Bun.Glob(pattern).scanSync({ cwd: root })].sort();
	const files = [
		"README.md",
		"README.zh-TW.md",
		".github/PACKAGE-RELEASES.md",
		...glob("docs/*.md"),
		...glob("packages/*/README.md"),
		...glob("site/src/content/docs/**/*.mdx"),
	].filter((file) => existsSync(join(root, file)));
	return files.sort();
}

/** The workspace directories under `packages/`, sorted. */
export function workspaceDirs(root: string): string[] {
	const packages = join(root, "packages");
	if (!existsSync(packages)) return [];
	return readdirSync(packages, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort((a, b) => a.localeCompare(b));
}

/** Every peer range the manifests declare, plus the one the core's own version implies. */
function allowedRanges(root: string): Set<string> {
	const read = (path: string) =>
		JSON.parse(readFileSync(join(root, path), "utf8")) as {
			version?: string;
			peerDependencies?: Record<string, string>;
		};
	const core = read("package.json");
	return new Set([
		...(core.version ? [peerRange(core.version)] : []),
		...Object.values(core.peerDependencies ?? {}),
		...workspaceDirs(root).flatMap((dir) =>
			Object.values(
				read(`packages/${dir}/package.json`).peerDependencies ?? {},
			),
		),
	]);
}

/** The peer ranges the docs state that no manifest declares, as `file:line range`. */
export function staleDocRanges(root: string): string[] {
	const allowed = allowedRanges(root);
	const stale: string[] = [];
	for (const file of docsFiles(root)) {
		readFileSync(join(root, file), "utf8")
			.split("\n")
			.forEach((line, index) => {
				for (const match of line.matchAll(RANGE_PATTERN))
					if (!allowed.has(match[0]))
						stale.push(`${file}:${index + 1} ${match[0]}`);
			});
	}
	return stale;
}
