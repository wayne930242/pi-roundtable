import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const examples = readdirSync(import.meta.dir).filter(
	(name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
);

/** The README embeds a file as a `ts` block between these two markers. */
const MARKER = /<!-- example: (\S+) -->/g;
const BLOCK =
	/<!-- example: (\S+) -->\n```ts\n([\s\S]*?)\n```\n<!-- \/example -->/g;

test("every marker in the README wraps one ts block", () => {
	expect([...readme.matchAll(BLOCK)].length).toBe(
		[...readme.matchAll(MARKER)].length,
	);
});

test("every block in the README is exactly the file it names", () => {
	for (const [, path, embedded] of readme.matchAll(BLOCK)) {
		const file = readFileSync(join(root, path as string), "utf8");
		expect({ path, code: embedded }).toEqual({ path, code: file.trimEnd() });
	}
});

test("every example is embedded in the README", () => {
	const embedded = [...readme.matchAll(MARKER)].map((match) => match[1]);
	for (const name of examples) expect(embedded).toContain(`examples/${name}`);
});
