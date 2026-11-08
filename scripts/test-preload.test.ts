import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

/** Bun reads only the bunfig.toml of the directory a run starts in, so each such directory names the preload itself. */
function preloadsOf(dir: string): string[] {
	const file = resolve(dir, "bunfig.toml");
	if (!existsSync(file)) return [];
	const test = /^\[test\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(
		readFileSync(file, "utf8"),
	);
	const list = /^\s*preload\s*=\s*\[([^\]]*)\]/m.exec(test?.[1] ?? "");
	return [...(list?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) =>
		resolve(dir, m[1] ?? ""),
	);
}

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		if (entry.name === "node_modules") return [];
		const path = resolve(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return entry.name.endsWith(".test.ts") ? [path] : [];
	});
}

const preload = resolve(root, "scripts/test-preload.ts");

test("a run from the repository root starts a test PostgreSQL", () => {
	expect(existsSync(preload)).toBe(true);
	expect(preloadsOf(root)).toContain(preload);
});

test("every package with PostgreSQL-backed tests starts one from its own directory", () => {
	const withDb = readdirSync(resolve(root, "packages"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => resolve(root, "packages", entry.name))
		.filter((dir) =>
			sourceFiles(dir).some((file) =>
				/\b(describeDb|requireDatabase|ROUNDTABLE_TEST_DATABASE_URL)\b/.test(
					readFileSync(file, "utf8"),
				),
			),
		);
	expect(withDb.length).toBeGreaterThan(0);
	for (const dir of withDb)
		expect(
			preloadsOf(dir).map((path) => relative(root, path)),
			`${relative(root, dir)} needs a bunfig.toml whose [test] preload is scripts/test-preload.ts`,
		).toContain(relative(root, preload));
});
