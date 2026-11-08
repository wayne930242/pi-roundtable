import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { workspaceDirs } from "./docs-files.ts";
import {
	baselineProblems,
	COLLECTED_WORKSPACES,
	declaredMigrationIds,
	type MigrationIds,
	readBaseline,
	recordedBaseline,
	WITHOUT_MIGRATIONS,
} from "./migration-ids.ts";

const root = resolve(import.meta.dir, "..");

const ids = (once: string[], everyBoot: string[] = []): MigrationIds => ({
	once,
	everyBoot,
});

// A deployed database holds these ids in its ledger; a name that changes runs the DDL a second time.
test("every migration the core and the official packages declare is recorded, and none recorded is lost", async () => {
	const declared = await declaredMigrationIds();
	expect(declared.once.length).toBeGreaterThan(60);
	expect(baselineProblems(readBaseline(), declared)).toEqual([]);
});

test("a renamed id is caught as a lost one and as one not recorded", () => {
	const recorded = ids(["a/one", "a/two", "b/three"]);
	const problems = baselineProblems(
		recorded,
		ids(["a/one", "a/second", "b/three"]),
	);
	expect(problems).toHaveLength(2);
	expect(problems[0]).toContain(
		"recorded migration a/two is no longer declared",
	);
	expect(problems[1]).toContain("a/second is declared but not recorded");
});

test("a removed, reordered or re-kinded id is caught", () => {
	const recorded = ids(["a/one", "a/two"], ["a/boot"]);
	expect(baselineProblems(recorded, ids(["a/one"], ["a/boot"]))[0]).toContain(
		"a/two is no longer declared",
	);
	expect(
		baselineProblems(recorded, ids(["a/two", "a/one"], ["a/boot"]))[0],
	).toContain("a/two moved");
	expect(baselineProblems(recorded, ids(["a/one", "a/two", "a/boot"]))).toEqual(
		[
			expect.stringContaining(
				"every-boot migration a/boot is no longer declared",
			),
			expect.stringContaining("migration a/boot is declared but not recorded"),
		],
	);
});

test("a new id, anywhere in the order, only asks to be recorded", () => {
	const problems = baselineProblems(
		ids(["a/one", "b/three"]),
		ids(["a/one", "a/two", "b/three"]),
	);
	expect(problems).toEqual([
		"migration a/two is declared but not recorded: run bun scripts/migration-ids.ts --record",
	]);
});

test("recording appends and refuses to forget unless told", () => {
	const recorded = ids(["a/one", "a/two"]);
	expect(recordedBaseline(recorded, ids(["a/one", "a/new", "a/two"]))).toEqual(
		ids(["a/one", "a/new", "a/two"]),
	);
	expect(() => recordedBaseline(recorded, ids(["a/one", "a/other"]))).toThrow(
		"a/two is no longer declared",
	);
	expect(recordedBaseline(recorded, ids(["a/one", "a/other"]), true)).toEqual(
		ids(["a/one", "a/other"]),
	);
});

test("every workspace is either built here or has no migration in its sources", () => {
	const dirs = workspaceDirs(root);
	expect([...COLLECTED_WORKSPACES, ...WITHOUT_MIGRATIONS].sort()).toEqual(dirs);
	for (const dir of WITHOUT_MIGRATIONS)
		for (const file of new Bun.Glob("**/*.ts").scanSync({
			cwd: resolve(root, "packages", dir, "src"),
		}))
			if (!file.endsWith(".test.ts"))
				expect(
					readFileSync(resolve(root, "packages", dir, "src", file), "utf8"),
				).not.toMatch(/\bmigrations\s*:|\bMigration\b/);
});
