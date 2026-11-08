import { afterEach, expect, test } from "bun:test";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { releasePackages } from "./check-release.ts";
import { docsFiles, staleDocRanges, workspaceDirs } from "./docs-files.ts";
import { release } from "./release.ts";

const repo = resolve(import.meta.dir, "..");
const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-release-"));
	made.push(dir);
	return dir;
};

const write = (root: string, file: string, text: string): void => {
	mkdirSync(dirname(join(root, file)), { recursive: true });
	writeFileSync(join(root, file), text);
};
const read = (root: string, file: string): string =>
	readFileSync(join(root, file), "utf8");

const manifest = (
	name: string,
	version: string,
	range: string,
	pin: string,
): string =>
	`${JSON.stringify(
		{
			name,
			version,
			peerDependencies: { "pi-roundtable": range, pi: ">=1.0.0 <2" },
			devDependencies: { "pi-roundtable": pin },
			repository: {
				directory: `packages/${name.replace("pi-roundtable-", "")}`,
			},
		},
		null,
		"\t",
	)}\n`;

const CHANGELOG = (version: string) =>
	`# Changelog\n\n## [Unreleased]\n\n## [${version}] - 2026-01-01\n\n- Old.\n`;

/** A tree shaped like the repository: root and two workspaces at 0.8.0, prose that states the range, and one fragment. */
function fixture(): string {
	const root = scratch();
	write(
		root,
		"package.json",
		`${JSON.stringify({ name: "pi-roundtable", version: "0.8.0" }, null, "\t")}\n`,
	);
	for (const dir of ["web", "mcp"]) {
		write(
			root,
			`packages/${dir}/package.json`,
			manifest(`pi-roundtable-${dir}`, "0.8.0", ">=0.8.0 <0.9.0", "0.8.0"),
		);
		write(root, `packages/${dir}/CHANGELOG.md`, CHANGELOG("0.8.0"));
		write(
			root,
			`packages/${dir}/README.md`,
			"Needs pi-roundtable `>=0.8.0 <0.9.0` and Pi `>=1.0.0 <2`.\n",
		);
	}
	write(root, "CHANGELOG.md", CHANGELOG("0.8.0"));
	write(
		root,
		"site/src/content/docs/plugins/web-package.mdx",
		"Use pi-roundtable `>=0.8.0 <0.9.0`.\n",
	);
	write(
		root,
		"site/src/content/docs/zh-tw/plugins/web-package.mdx",
		"Needs `>=0.8.0 <0.9.0` of pi-roundtable (zh-tw page).\n",
	);
	write(
		root,
		"changes/unreleased/web-fix.md",
		"---\ntype: Fixed\npackages: [web]\n---\nThe page reopens a block.\n",
	);
	return root;
}

const options = (root: string, version = "0.9.0") => ({
	root,
	version,
	date: "2026-02-03",
	offline: true,
	install: false,
	tests: false,
	out: () => {},
});

test("a release moves the version, the pins, the ranges in manifests and prose, and the changelogs", async () => {
	const root = fixture();
	await release({ ...options(root), summary: "a fix" });
	const core = JSON.parse(read(root, "package.json")) as { version: string };
	expect(core.version).toBe("0.9.0");
	for (const dir of ["web", "mcp"]) {
		const pkg = JSON.parse(read(root, `packages/${dir}/package.json`)) as {
			version: string;
			peerDependencies: Record<string, string>;
			devDependencies: Record<string, string>;
		};
		expect(pkg.version).toBe("0.9.0");
		expect(pkg.peerDependencies["pi-roundtable"]).toBe(">=0.9.0 <0.10.0");
		// A range that is not the core's is left alone.
		expect(pkg.peerDependencies.pi).toBe(">=1.0.0 <2");
		expect(pkg.devDependencies["pi-roundtable"]).toBe("0.9.0");
		expect(read(root, `packages/${dir}/package.json`)).toContain('\n\t"name"');
		expect(read(root, `packages/${dir}/README.md`)).toBe(
			"Needs pi-roundtable `>=0.9.0 <0.10.0` and Pi `>=1.0.0 <2`.\n",
		);
	}
	expect(read(root, "site/src/content/docs/plugins/web-package.mdx")).toBe(
		"Use pi-roundtable `>=0.9.0 <0.10.0`.\n",
	);
	expect(
		read(root, "site/src/content/docs/zh-tw/plugins/web-package.mdx"),
	).toBe("Needs `>=0.9.0 <0.10.0` of pi-roundtable (zh-tw page).\n");
	expect(read(root, "packages/web/CHANGELOG.md")).toBe(
		"# Changelog\n\n## [Unreleased]\n\n## [0.9.0] - 2026-02-03\n\n### Fixed\n\n- The page reopens a block.\n\n## [0.8.0] - 2026-01-01\n\n- Old.\n",
	);
	expect(read(root, "CHANGELOG.md")).toContain(
		"## [0.9.0] - 2026-02-03\n\n### Fixed\n\n- pi-roundtable-web: The page reopens a block.\n\n## [0.8.0]",
	);
	expect(read(root, "packages/mcp/CHANGELOG.md")).toContain(
		"## [0.9.0] - 2026-02-03\n\n- Release in lockstep with pi-roundtable 0.9.0 (a fix); no package-specific behavior changes.\n",
	);
	expect(existsSync(join(root, "changes/unreleased/web-fix.md"))).toBe(false);
	expect(releasePackages(root, "v0.9.0")).toHaveLength(2);
	expect(staleDocRanges(root)).toEqual([]);
});

test("a dry run reports the release and writes nothing", async () => {
	const root = fixture();
	const lines: string[] = [];
	await release({ ...options(root), dryRun: true, out: (l) => lines.push(l) });
	expect(read(root, "package.json")).toContain('"0.8.0"');
	expect(existsSync(join(root, "changes/unreleased/web-fix.md"))).toBe(true);
	expect(lines.join("\n")).toContain(
		"pi-roundtable-web: The page reopens a block.",
	);
	expect(lines.join("\n")).toContain("packages/web/README.md");
});

test("a release refuses a version that is not newer, or is already tagged or published", async () => {
	const root = fixture();
	for (const version of ["0.8.0", "0.7.9", "0.9", "v0.9.0"])
		await expect(release(options(root, version))).rejects.toThrow(
			/not newer|release version/,
		);
	const remote = (tag: boolean, published: string[]) => ({
		tagExists: async () => tag,
		publishedVersions: async () => published,
	});
	await expect(
		release({ ...options(root), offline: false, remote: remote(true, []) }),
	).rejects.toThrow("v0.9.0 is already a tag on origin");
	await expect(
		release({
			...options(root),
			offline: false,
			remote: remote(false, ["0.9.0"]),
		}),
	).rejects.toThrow("0.9.0 is already on npm");
	expect(read(root, "package.json")).toContain('"0.8.0"');
	await release({
		...options(root),
		offline: false,
		remote: remote(false, ["0.8.0"]),
	});
	expect(read(root, "package.json")).toContain('"0.9.0"');
});

test("a release stops, with nothing written, on a workspace out of lockstep, a bad fragment, or nothing to say", async () => {
	const root = fixture();
	write(
		root,
		"packages/mcp/package.json",
		manifest("pi-roundtable-mcp", "0.8.0", ">=0.7.0 <0.8.0", "0.8.0"),
	);
	await expect(release(options(root))).rejects.toThrow("pi-roundtable-mcp");
	write(
		root,
		"packages/mcp/package.json",
		manifest("pi-roundtable-mcp", "0.8.0", ">=0.8.0 <0.9.0", "0.8.0"),
	);
	write(
		root,
		"changes/unreleased/bad.md",
		"---\ntype: Oops\npackages: [web]\n---\nx\n",
	);
	await expect(release(options(root))).rejects.toThrow("type must be one of");
	rmSync(join(root, "changes/unreleased/bad.md"));
	rmSync(join(root, "changes/unreleased/web-fix.md"));
	await expect(release(options(root))).rejects.toThrow("nothing to release");
	expect(read(root, "package.json")).toContain('"0.8.0"');
	expect(read(root, "packages/web/README.md")).toContain("0.8.0");
});

test("entries already under Unreleased are kept and join the fragments", async () => {
	const root = fixture();
	write(
		root,
		"packages/mcp/CHANGELOG.md",
		"# Changelog\n\n## [Unreleased]\n\n### Added\n\n- By hand.\n\n## [0.8.0] - 2026-01-01\n\n- Old.\n",
	);
	await release(options(root));
	expect(read(root, "packages/mcp/CHANGELOG.md")).toContain(
		"## [0.9.0] - 2026-02-03\n\n### Added\n\n- By hand.\n\n## [0.8.0]",
	);
});

/** The metadata files of this repository, copied: the release must reach every spot the real tree states a version. */
function copyOfRepo(): string {
	const root = scratch();
	const files = [
		"package.json",
		"CHANGELOG.md",
		...workspaceDirs(repo).flatMap((dir) => [
			`packages/${dir}/package.json`,
			`packages/${dir}/CHANGELOG.md`,
		]),
		...docsFiles(repo),
	];
	for (const file of files) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		cpSync(join(repo, file), join(root, file));
	}
	return root;
}

test("on a copy of this repository every range the docs state moves with the release", async () => {
	const root = copyOfRepo();
	const [major = 0, minor = 0] = (
		JSON.parse(read(root, "package.json")) as { version: string }
	).version
		.split(".")
		.map(Number);
	const version = `${major}.${minor + 1}.0`;
	write(
		root,
		"changes/unreleased/probe.md",
		"---\ntype: Added\npackages: [core]\n---\nA probe.\n",
	);
	await release(options(root, version));
	expect(releasePackages(root, `v${version}`).length).toBeGreaterThan(1);
	expect(staleDocRanges(root)).toEqual([]);
	expect(read(root, "CHANGELOG.md")).toContain(`## [${version}] - 2026-02-03`);
});
