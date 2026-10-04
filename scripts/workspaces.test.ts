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

test("coding and core share the same Pi instances, including in the canary", () => {
	for (const name of [
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-ai",
	])
		expect(
			realpathSync(Bun.resolveSync(name, resolve(root, "packages/coding"))),
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

test("public scan covers all workspaces and allows only explicit public metadata", () => {
	const findings = scanTree(root).filter((finding) =>
		finding.file.startsWith("packages/"),
	);
	expect(findings).toEqual([]);
});
