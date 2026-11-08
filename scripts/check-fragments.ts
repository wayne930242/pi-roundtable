import {
	FRAGMENT_DIR,
	FragmentError,
	loadFragments,
} from "./changelog-fragments.ts";
import { workspaceDirs } from "./docs-files.ts";

/** Whether a change to this file reaches a user of a published package: shipped source, not a test. */
export function isShippedSource(path: string): boolean {
	if (/\.test\.tsx?$/.test(path)) return false;
	return (
		/^src\//.test(path) ||
		/^packages\/[^/]+\/(src|web)\//.test(path) ||
		/^templates\//.test(path)
	);
}

const isManifest = (path: string): boolean =>
	/^(packages\/[^/]+\/)?package\.json$/.test(path);

function git(root: string, ...args: string[]): string {
	const run = Bun.spawnSync(["git", ...args], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (run.exitCode !== 0)
		throw new Error(`git ${args.join(" ")}: ${run.stderr.toString().trim()}`);
	return run.stdout.toString();
}

/** What a manifest offers its users: the entries it exports and the commands it installs. */
function surface(text: string): string {
	const manifest = JSON.parse(text) as { exports?: unknown; bin?: unknown };
	return JSON.stringify([manifest.exports ?? null, manifest.bin ?? null]);
}

/**
 * The reasons this branch's changes since `base` break the fragment rule, none when it keeps it:
 * a change to shipped source (or to a manifest's `exports` or `bin`) adds a file under
 * `changes/unreleased`, and every fragment in the tree reads. A change that deletes fragments is the
 * release, which consumes them.
 */
export function checkFragments(root: string, base: string): string[] {
	const problems: string[] = [];
	try {
		loadFragments(root, workspaceDirs(root));
	} catch (error) {
		if (!(error instanceof FragmentError)) throw error;
		problems.push(error.message);
	}
	const changes = git(
		root,
		"diff",
		"--name-status",
		"--no-renames",
		`${base}...HEAD`,
	)
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [status = "", path = ""] = line.split("\t");
			return { status, path };
		});
	const inFragments = (path: string) =>
		path.startsWith(`${FRAGMENT_DIR}/`) && path.endsWith(".md");
	if (changes.some((c) => c.status === "D" && inFragments(c.path)))
		return problems;
	const shipped = changes.filter((c) => {
		if (isShippedSource(c.path)) return true;
		if (!isManifest(c.path) || c.status !== "M") return false;
		return (
			surface(git(root, "show", `${base}:${c.path}`)) !==
			surface(git(root, "show", `HEAD:${c.path}`))
		);
	});
	if (
		shipped.length > 0 &&
		!changes.some((c) => c.status === "A" && inFragments(c.path))
	)
		problems.push(
			`${shipped
				.map((c) => c.path)
				.slice(0, 3)
				.join(
					", ",
				)}${shipped.length > 3 ? ` and ${shipped.length - 3} more` : ""} changed, and no file was added under ${FRAGMENT_DIR}/: add ${FRAGMENT_DIR}/<branch>.md (type: none when nothing a user sees changed); see changes/README.md`,
		);
	return problems;
}

if (import.meta.main) {
	const base = process.argv[2];
	if (!base)
		throw new Error("Usage: bun scripts/check-fragments.ts <base-ref>");
	const problems = checkFragments(process.cwd(), base);
	for (const problem of problems) console.error(`check-fragments: ${problem}`);
	process.exit(problems.length > 0 ? 1 : 0);
}
