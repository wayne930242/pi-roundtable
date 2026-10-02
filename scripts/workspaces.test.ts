import { expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
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

test("public scan covers all workspaces and allows only explicit public metadata", () => {
	const findings = scanTree(root).filter((finding) =>
		finding.file.startsWith("packages/"),
	);
	expect(findings).toEqual([]);
});
