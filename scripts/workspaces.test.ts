import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { releasePackages } from "./check-release.ts";
import { scanTree } from "./scan-public.ts";

const root = resolve(import.meta.dir, "..");

test("every workspace resolves the live core rather than a registry copy", () => {
	const core = JSON.parse(
		readFileSync(resolve(root, "package.json"), "utf8"),
	) as { version: string };
	for (const pkg of releasePackages(root, `v${core.version}`)) {
		const require = createRequire(resolve(root, pkg.path, "package.json"));
		expect(realpathSync(require.resolve("pi-roundtable"))).toBe(
			resolve(root, "src/index.ts"),
		);
		expect(existsSync(resolve(root, pkg.path, "bun.lock"))).toBe(false);
		expect(
			existsSync(resolve(root, pkg.path, ".github/workflows/ci.yml")),
		).toBe(false);
		expect(
			existsSync(resolve(root, pkg.path, ".github/workflows/publish.yml")),
		).toBe(false);
	}
});

// Package tests share one test database, and every host's boot syncs the configured owners into it,
// so two packages' tests running at once revoke each other's owners mid-test.
test("package tests run one workspace at a time, in CI and in check:packages", () => {
	const scripts = (
		JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
			scripts: Record<string, string>;
		}
	).scripts;
	const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
	const runs = [
		...ci.matchAll(/bun run --workspaces[^\n]*\btest\b/g),
		...(scripts["check:packages"] ?? "").matchAll(
			/bun run --workspaces[^&]*\btest\b/g,
		),
	].map((m) => m[0].trim());
	expect(runs).toEqual([
		"bun run --workspaces --sequential test",
		"bun run --workspaces --sequential test",
	]);
});

test("coding, browser and core share the same Pi instances, including in the canary", () => {
	for (const pkg of ["coding", "browser"])
		for (const name of [
			"@earendil-works/pi-coding-agent",
			"@earendil-works/pi-ai",
		])
			expect(
				realpathSync(Bun.resolveSync(name, resolve(root, "packages", pkg))),
			).toBe(realpathSync(Bun.resolveSync(name, root)));
});

test("drawing ships the declarations required to compile its published source", () => {
	const manifest = JSON.parse(
		readFileSync(resolve(root, "packages/drawing/package.json"), "utf8"),
	) as {
		dependencies: Record<string, string>;
		devDependencies: Record<string, string>;
	};
	expect(manifest.dependencies["@types/d3-force"]).toBeDefined();
	expect(manifest.devDependencies["@types/d3-force"]).toBeUndefined();
});

test("a public compactor environment name is allowed only in its integration test", () => {
	const dir = mkdtempSync(resolve(tmpdir(), "roundtable-scan-"));
	const integration = `src/kit/${["j", "ev"].join("")}.test.ts`;
	const variable = ["TYPE", "SAFE_API_KEY"].join("");
	try {
		mkdirSync(resolve(dir, "src/kit"), { recursive: true });
		writeFileSync(
			resolve(dir, integration),
			`delete process.env.${variable};\n`,
		);
		expect(scanTree(dir)).toEqual([]);
		writeFileSync(resolve(dir, "other.ts"), variable);
		expect(scanTree(dir).map(({ file, kind }) => ({ file, kind }))).toEqual([
			{ file: "other.ts", kind: "name" },
		]);
		writeFileSync(
			resolve(dir, integration),
			`const key = "sk-${"x".repeat(24)}";\n`,
		);
		expect(
			scanTree(dir).some(
				({ file, kind }) => file === integration && kind === "credential",
			),
		).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a name inside another word is not the name, at a word's start it is", () => {
	const dir = mkdtempSync(resolve(tmpdir(), "roundtable-scan-"));
	// Built at run time, so this file does not trip the scan it tests.
	const name = ["no", "ul"].join("");
	try {
		writeFileSync(resolve(dir, "keywords.js"), `const k="ber${name}li";\n`);
		expect(scanTree(dir)).toEqual([]);
		writeFileSync(resolve(dir, "person.js"), `const a="${name}",b="${name}Bot";\n`);
		expect(scanTree(dir).map(({ file, kind }) => `${file} ${kind}`)).toEqual([
			"person.js name",
			"person.js name",
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// CI scans a fresh checkout; locally only tracked files count, so build output and scratch notes do not.
const trackedFindings = () => {
	const tracked = new Set(
		Bun.spawnSync(["git", "ls-files"], { cwd: root })
			.stdout.toString()
			.split("\n"),
	);
	return scanTree(root).filter((finding) => tracked.has(finding.file));
};

test("built web bundles skip the Chinese and snowflake checks, but not credentials", () => {
	const dir = mkdtempSync(resolve(tmpdir(), "roundtable-scan-"));
	// Built at run time, so this file does not trip the scan it tests.
	const word = String.fromCodePoint(0x90e8, 0x7f72);
	const digits = ["1591549", "4309189535"].join("");
	try {
		mkdirSync(resolve(dir, "packages/web/dist"), { recursive: true });
		writeFileSync(
			resolve(dir, "packages/web/dist/chunk.js"),
			`const words=["${word}"],k=0.${digits};\n`,
		);
		expect(scanTree(dir)).toEqual([]);
		writeFileSync(resolve(dir, "chunk.js"), `const k=${digits};\n`);
		writeFileSync(
			resolve(dir, "packages/web/dist/leak.js"),
			`const key = "sk-${"x".repeat(24)}";\n`,
		);
		// The directory walk follows the file system's order, which differs between macOS and Linux.
		expect(
			scanTree(dir)
				.map(({ file, kind }) => `${file} ${kind}`)
				.sort(),
		).toEqual(["chunk.js snowflake", "packages/web/dist/leak.js credential"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the whole tree passes the public scan CI runs", () => {
	expect(trackedFindings()).toEqual([]);
});

test("public scan covers all workspaces and allows only explicit public metadata", () => {
	const findings = trackedFindings().filter((finding) =>
		finding.file.startsWith("packages/"),
	);
	expect(findings).toEqual([]);
});
