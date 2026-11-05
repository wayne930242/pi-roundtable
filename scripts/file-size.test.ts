import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { oversizedFiles } from "./file-size.ts";

const ROOT = resolve(import.meta.dir, "..");

const trees: string[] = [];
afterEach(() => {
	for (const dir of trees.splice(0)) rmSync(dir, { recursive: true });
});

/** A checkout holding files of the given line counts, by path. */
function tree(files: Record<string, number>): string {
	const root = mkdtempSync(join(tmpdir(), "roundtable-file-size-"));
	trees.push(root);
	for (const [path, lines] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), "x;\n".repeat(lines));
	}
	return root;
}

test("no file grows past the size limit, and the recorded oversized files only shrink", () => {
	const baseline = JSON.parse(
		readFileSync(join(ROOT, "scripts/file-size.baseline.json"), "utf8"),
	) as Record<string, number>;
	// Exact: a new oversized file, or a recorded one that grew, fails; a recorded one that shrank
	// prompts lowering its count, or removing it once it is within the limit. Split a file rather
	// than raise its count. `bun scripts/file-size.ts` prints the current list.
	expect(oversizedFiles(ROOT)).toEqual(baseline);
});

test("a source file may have 500 lines and a test file 700; installed and built output is skipped", () => {
	const root = tree({
		"src/core/fits.ts": 500,
		"src/core/long.ts": 501,
		"src/core/long.test.ts": 700,
		"packages/web/web/longer.test.tsx": 701,
		"packages/web/node_modules/dep/index.ts": 900,
		"packages/web/dist/chunk.ts": 900,
		"scripts/notes.md": 900,
	});
	expect(oversizedFiles(root)).toEqual({
		"packages/web/web/longer.test.tsx": 701,
		"src/core/long.ts": 501,
	});
});
