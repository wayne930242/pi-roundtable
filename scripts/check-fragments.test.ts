import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkFragments, isShippedSource } from "./check-fragments.ts";

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
	const run = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
	if (run.exitCode !== 0)
		throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

const write = (root: string, file: string, text: string): void => {
	mkdirSync(dirname(join(root, file)), { recursive: true });
	writeFileSync(join(root, file), text);
};

const FRAGMENT = "---\ntype: Fixed\npackages: [web]\n---\nA fix.\n";
const manifest = (exports: string) =>
	`${JSON.stringify({ name: "x", version: "1.0.0", exports: { ".": exports } })}\n`;

/** A repository on master with one workspace, and a branch `work` checked out from it. */
function repo(): string {
	const root = mkdtempSync(join(tmpdir(), "roundtable-check-fragments-"));
	made.push(root);
	git(root, "init", "-q", "-b", "master");
	git(root, "config", "user.email", "t@example.com");
	git(root, "config", "user.name", "t");
	write(root, "src/a.ts", "export {};\n");
	write(root, "packages/web/src/b.ts", "export {};\n");
	write(root, "packages/web/package.json", manifest("./src/b.ts"));
	write(root, "changes/unreleased/old.md", FRAGMENT);
	git(root, "add", "-A");
	git(root, "commit", "-qm", "base");
	git(root, "checkout", "-q", "-b", "work");
	return root;
}

const commit = (root: string): void => {
	git(root, "add", "-A");
	git(root, "commit", "-qm", "work");
};

test("a change to shipped source without a new fragment fails", () => {
	const root = repo();
	write(root, "packages/web/src/b.ts", "export const x = 1;\n");
	commit(root);
	const problems = checkFragments(root, "master");
	expect(problems).toHaveLength(1);
	expect(problems[0]).toContain("packages/web/src/b.ts");
	expect(problems[0]).toContain("changes/unreleased");
});

test("a new fragment satisfies it; a change to an existing one does not", () => {
	const root = repo();
	write(root, "src/a.ts", "export const x = 1;\n");
	write(root, "changes/unreleased/old.md", `${FRAGMENT}More.\n`);
	commit(root);
	expect(checkFragments(root, "master")).toHaveLength(1);
	write(root, "changes/unreleased/work.md", FRAGMENT);
	commit(root);
	expect(checkFragments(root, "master")).toEqual([]);
});

test("a test, a doc or a lockfile alone needs none", () => {
	const root = repo();
	write(root, "src/a.test.ts", "export {};\n");
	write(root, "docs/x.md", "x\n");
	write(root, "bun.lock", "{}\n");
	commit(root);
	expect(checkFragments(root, "master")).toEqual([]);
	expect(isShippedSource("src/a.test.ts")).toBe(false);
	expect(isShippedSource("packages/web/web/app.tsx")).toBe(true);
	expect(isShippedSource("templates/x.md")).toBe(true);
});

test("a manifest needs one when its exports change, not its version", () => {
	const root = repo();
	write(
		root,
		"packages/web/package.json",
		`${JSON.stringify({ name: "x", version: "2.0.0", exports: { ".": "./src/b.ts" } })}\n`,
	);
	commit(root);
	expect(checkFragments(root, "master")).toEqual([]);
	write(root, "packages/web/package.json", manifest("./src/c.ts"));
	commit(root);
	expect(checkFragments(root, "master")).toHaveLength(1);
});

test("the release, which deletes the fragments, is exempt", () => {
	const root = repo();
	write(root, "src/a.ts", "export const x = 1;\n");
	rmSync(join(root, "changes/unreleased/old.md"));
	commit(root);
	expect(checkFragments(root, "master")).toEqual([]);
});

test("a fragment that does not read fails whatever else changed", () => {
	const root = repo();
	write(
		root,
		"changes/unreleased/bad.md",
		"---\ntype: Oops\npackages: [web]\n---\nx\n",
	);
	commit(root);
	expect(checkFragments(root, "master").join("\n")).toContain(
		"type must be one of",
	);
});
