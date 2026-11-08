import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { docsFiles, staleDocRanges, workspaceDirs } from "./docs-files.ts";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const docs = () => docsFiles(root);
const workspaces = workspaceDirs(root);

// Peer ranges drifted for fourteen minors because nothing tied the prose to the manifests.
test("every peer range a doc states is one a manifest declares", () => {
	expect(staleDocRanges(root)).toEqual([]);
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
