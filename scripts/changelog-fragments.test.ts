import { expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	distribute,
	type Entries,
	emptyEntries,
	FragmentError,
	insertRelease,
	loadFragments,
	lockstepLine,
	parseFragment,
	parseUnreleased,
	renderEntries,
} from "./changelog-fragments.ts";

const WORKSPACES = ["mcp", "web"];
const fragment = (type: string, packages: string, body: string) =>
	`---\ntype: ${type}\npackages: ${packages}\n---\n${body}\n`;

test("a fragment names its type, its packages and one entry per paragraph", () => {
	expect(
		parseFragment(
			"changes/unreleased/a.md",
			fragment("Fixed", "[core, web]", "First line\ncontinued.\n\n- Second."),
			WORKSPACES,
		),
	).toEqual({
		file: "changes/unreleased/a.md",
		type: "Fixed",
		packages: ["core", "web"],
		root: true,
		bullets: ["First line continued.", "Second."],
	});
});

test("a fragment with an unknown type, package, field or no text is refused", () => {
	const bad = (text: string, message: string) =>
		expect(() => parseFragment("f.md", text, WORKSPACES)).toThrow(message);
	bad(fragment("Fixes", "[web]", "x"), "type must be one of");
	bad(fragment("Fixed", "[webb]", "x"), "unknown package webb");
	bad(fragment("Fixed", "[]", "x"), "packages is a list");
	bad(fragment("Fixed", "[web]", "  \n"), "has no text");
	bad("---\ntype: Fixed\npackages: [web]\nroot: maybe\n---\nx", "root is");
	bad("---\ntype: Fixed\ncolour: red\n---\nx", "unknown front matter field");
	bad("no front matter", "front matter");
	expect(() => parseFragment("f.md", "x", [])).toThrow(FragmentError);
});

test("type none needs no package and is left out of the changelogs", () => {
	const none = parseFragment(
		"f.md",
		"---\ntype: none\n---\nTest-only change.\n",
		WORKSPACES,
	);
	expect(none.packages).toEqual([]);
	expect(distribute([none], new Map()).size).toBe(0);
});

function entriesOf(target: string, map: Map<string, Entries>): string {
	return renderEntries(map.get(target) ?? emptyEntries(), "LOCKSTEP");
}

test("a workspace fragment reaches its changelog and, led by the package name, the root's", () => {
	const fragments = [
		parseFragment(
			"b.md",
			fragment(
				"Fixed",
				"[web]",
				"pi-roundtable-web: Stale prefix is not doubled.",
			),
			WORKSPACES,
		),
		parseFragment(
			"a.md",
			fragment("Added", "[core]", "A core thing."),
			WORKSPACES,
		),
		parseFragment(
			"c.md",
			fragment("Added", "[web, mcp]", "Both.\n\nroot: false is not set."),
			WORKSPACES,
		),
		parseFragment(
			"d.md",
			"---\ntype: Changed\npackages: [mcp]\nroot: false\n---\nQuiet.\n",
			WORKSPACES,
		),
	];
	const map = distribute(fragments, new Map());
	expect(entriesOf("core", map)).toBe(
		[
			"### Added",
			"",
			"- A core thing.",
			"- pi-roundtable-web, pi-roundtable-mcp: Both.",
			"- pi-roundtable-web, pi-roundtable-mcp: root: false is not set.",
			"",
			"### Fixed",
			"",
			"- pi-roundtable-web: Stale prefix is not doubled.",
		].join("\n"),
	);
	expect(entriesOf("web", map)).toBe(
		[
			"### Added",
			"",
			"- Both.",
			"- root: false is not set.",
			"",
			"### Fixed",
			"",
			"- pi-roundtable-web: Stale prefix is not doubled.",
		].join("\n"),
	);
	expect(entriesOf("mcp", map)).toBe(
		"### Added\n\n- Both.\n- root: false is not set.\n\n### Changed\n\n- Quiet.",
	);
	// d.md asked to stay out of the root.
	expect(entriesOf("core", map)).not.toContain("Quiet");
});

test("assembling gives the same text whatever order the files were made in", () => {
	const root = mkdtempSync(join(tmpdir(), "roundtable-fragments-"));
	try {
		mkdirSync(join(root, "changes/unreleased"), { recursive: true });
		for (const [name, type, text] of [
			["c.md", "Fixed", "Three."],
			["a.md", "Fixed", "One."],
			["b.md", "Added", "Two."],
		] as const)
			writeFileSync(
				join(root, "changes/unreleased", name),
				fragment(type, "[web]", text),
			);
		expect(
			entriesOf("web", distribute(loadFragments(root, WORKSPACES), new Map())),
		).toBe("### Added\n\n- Two.\n\n### Fixed\n\n- One.\n- Three.");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("entries already under Unreleased come first and are kept in their sections", () => {
	const text = [
		"# Changelog",
		"",
		"## [Unreleased]",
		"",
		"### Fixed",
		"",
		"- Written by hand,",
		"  over two lines.",
		"",
		"## [0.1.0] - 2026-01-01",
		"",
		"- Old.",
		"",
	].join("\n");
	const held = parseUnreleased(text);
	expect(held.groups.get("Fixed")).toEqual([
		"Written by hand,\n  over two lines.",
	]);
	const map = distribute(
		[parseFragment("a.md", fragment("Fixed", "[web]", "New."), WORKSPACES)],
		new Map([["web", held]]),
	);
	expect(entriesOf("web", map)).toBe(
		"### Fixed\n\n- Written by hand,\n  over two lines.\n- New.",
	);
});

test("a changelog with nothing to say gets the lockstep line", () => {
	expect(renderEntries(emptyEntries(), lockstepLine("0.43.0", "a fix"))).toBe(
		"- Release in lockstep with pi-roundtable 0.43.0 (a fix); no package-specific behavior changes.",
	);
	expect(lockstepLine("0.43.0")).toBe(
		"Release in lockstep with pi-roundtable 0.43.0; no package-specific behavior changes.",
	);
});

test("the release section goes under an emptied Unreleased heading", () => {
	const text =
		"# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- x\n\n## [0.1.0] - 2026-01-01\n\n- Old.\n";
	expect(insertRelease(text, "0.2.0", "2026-02-02", "- New.")).toBe(
		"# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-02-02\n\n- New.\n\n## [0.1.0] - 2026-01-01\n\n- Old.\n",
	);
	expect(() => insertRelease(text, "0.1.0", "2026-02-02", "- New.")).toThrow(
		"already has",
	);
	expect(() => insertRelease("# Changelog\n", "0.2.0", "d", "x")).toThrow(
		"no ## [Unreleased]",
	);
	expect(insertRelease("## [Unreleased]\n", "0.1.0", "d", "- New.")).toBe(
		"## [Unreleased]\n\n## [0.1.0] - d\n\n- New.\n\n",
	);
});

function git(cwd: string, ...args: string[]): void {
	const run = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
	if (run.exitCode !== 0)
		throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

test("two branches that each add a fragment merge without a conflict", () => {
	const root = mkdtempSync(join(tmpdir(), "roundtable-fragments-"));
	try {
		git(root, "init", "-q", "-b", "master");
		git(root, "config", "user.email", "t@example.com");
		git(root, "config", "user.name", "t");
		mkdirSync(join(root, "changes/unreleased"), { recursive: true });
		writeFileSync(join(root, "README.md"), "x\n");
		git(root, "add", "-A");
		git(root, "commit", "-qm", "base");
		for (const [branch, type] of [
			["one", "Added"],
			["two", "Fixed"],
		] as const) {
			git(root, "checkout", "-q", "-b", branch, "master");
			mkdirSync(join(root, "changes/unreleased"), { recursive: true });
			writeFileSync(
				join(root, `changes/unreleased/${branch}.md`),
				fragment(type, "[web]", `From ${branch}.`),
			);
			git(root, "add", "-A");
			git(root, "commit", "-qm", branch);
		}
		git(root, "checkout", "-q", "one");
		git(root, "merge", "--no-edit", "two");
		expect(loadFragments(root, WORKSPACES).map((f) => f.file)).toEqual([
			"changes/unreleased/one.md",
			"changes/unreleased/two.md",
		]);
		expect(
			readFileSync(join(root, "changes/unreleased/two.md"), "utf8"),
		).toContain("From two.");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
