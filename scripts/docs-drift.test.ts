import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

function docs(): string[] {
	const files = [
		"README.md",
		"README.zh-TW.md",
		".github/PACKAGE-RELEASES.md",
		...new Bun.Glob("docs/*.md").scanSync({ cwd: root }),
		...new Bun.Glob("packages/*/README.md").scanSync({ cwd: root }),
		...new Bun.Glob("site/src/content/docs/**/*.mdx").scanSync({ cwd: root }),
	];
	return files.sort();
}

const workspaces = readdirSync(resolve(root, "packages"), {
	withFileTypes: true,
}).filter((entry) => entry.isDirectory());

function allowedRanges(): Set<string> {
	const core = JSON.parse(read("package.json")) as {
		version: string;
		peerDependencies: Record<string, string>;
	};
	const [major = 0, minor = 0] = core.version.split(".").map(Number);
	return new Set([
		`>=${major}.${minor}.0 <${major}.${minor + 1}.0`,
		...Object.values(core.peerDependencies),
		...workspaces.flatMap((entry) => {
			const manifest = JSON.parse(
				read(`packages/${entry.name}/package.json`),
			) as { peerDependencies?: Record<string, string> };
			return Object.values(manifest.peerDependencies ?? {});
		}),
	]);
}

// Peer ranges drifted for fourteen minors because nothing tied the prose to the manifests.
test("every peer range a doc states is one a manifest declares", () => {
	const allowed = allowedRanges();
	const stale: string[] = [];
	for (const file of docs()) {
		const lines = read(file).split("\n");
		lines.forEach((line, index) => {
			for (const match of line.matchAll(/>=\d+\.\d+\.\d+ ?<\d+\.\d+\.\d+/g))
				if (!allowed.has(match[0]))
					stale.push(`${file}:${index + 1} ${match[0]}`);
		});
	}
	expect(stale).toEqual([]);
});

test("every doc that counts the official packages counts the workspaces", () => {
	const words = [
		"one",
		"two",
		"three",
		"four",
		"five",
		"six",
		"seven",
		"eight",
		"nine",
		"ten",
		"eleven",
		"twelve",
	];
	const wrong: string[] = [];
	for (const file of docs()) {
		const lines = read(file).split("\n");
		lines.forEach((line, index) => {
			for (const match of line.matchAll(
				new RegExp(`\\b(${words.join("|")}) official packages\\b`, "gi"),
			))
				if (
					words.indexOf(match[1]?.toLowerCase() ?? "") + 1 !==
					workspaces.length
				)
					wrong.push(`${file}:${index + 1} ${match[0]}`);
		});
	}
	expect(wrong).toEqual([]);
});
