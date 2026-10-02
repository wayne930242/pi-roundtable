import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReleaseContractError, releasePackages } from "./check-release.ts";

function fixture(run: (root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "roundtable-release-"));
	try {
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ name: "pi-roundtable", version: "0.8.0" }),
		);
		for (const name of ["drawing", "coding", "web", "sandbox", "mcp"]) {
			mkdirSync(join(root, "packages", name), { recursive: true });
			writePackage(root, name);
		}
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function writePackage(
	root: string,
	name: string,
	version = "0.8.0",
	peer = ">=0.8.0 <0.9.0",
): void {
	writeFileSync(
		join(root, "packages", name, "package.json"),
		JSON.stringify({
			name: `pi-roundtable-${name}`,
			version,
			peerDependencies: { "pi-roundtable": peer },
			devDependencies: { "pi-roundtable": version },
			repository: { directory: `packages/${name}` },
		}),
	);
}

test("one tag validates every package, including later sandbox and mcp imports", () => {
	fixture((root) => {
		expect(releasePackages(root, "v0.8.0")).toEqual(
			["coding", "drawing", "mcp", "sandbox", "web"].map((name) => ({
				name: `pi-roundtable-${name}`,
				path: `packages/${name}`,
			})),
		);
	});
});

test("refuses a tag that differs from the core or uses a per-package scheme", () => {
	fixture((root) => {
		for (const tag of ["v0.7.0", "drawing-v0.8.0", "v0.8.1"])
			expect(() => releasePackages(root, tag)).toThrow(ReleaseContractError);
	});
});

test("refuses a workspace whose version or core peer range is out of lockstep", () => {
	fixture((root) => {
		writePackage(root, "mcp", "0.4.1");
		expect(() => releasePackages(root, "v0.8.0")).toThrow("must be 0.8.0");
		writePackage(root, "mcp", "0.8.0", ">=0.7.0 <0.8.0");
		expect(() => releasePackages(root, "v0.8.0")).toThrow("must peer");
	});
});

test("refuses stale development pins and repository directories", () => {
	fixture((root) => {
		const path = join(root, "packages/mcp/package.json");
		const pkg = {
			name: "pi-roundtable-mcp",
			version: "0.8.0",
			peerDependencies: { "pi-roundtable": ">=0.8.0 <0.9.0" },
			devDependencies: { "pi-roundtable": "0.7.0" },
			repository: { directory: "packages/mcp" },
		};
		writeFileSync(path, JSON.stringify(pkg));
		expect(() => releasePackages(root, "v0.8.0")).toThrow("must develop");
		pkg.devDependencies["pi-roundtable"] = "0.8.0";
		pkg.repository.directory = "old-repository";
		writeFileSync(path, JSON.stringify(pkg));
		expect(() => releasePackages(root, "v0.8.0")).toThrow(
			"repository directory",
		);
	});
});

test("malformed manifests fail closed with a release-specific error", () => {
	fixture((root) => {
		for (const text of ["null", "{"]) {
			writeFileSync(join(root, "packages/web/package.json"), text);
			expect(() => releasePackages(root, "v0.8.0")).toThrow(
				ReleaseContractError,
			);
		}
	});
});
