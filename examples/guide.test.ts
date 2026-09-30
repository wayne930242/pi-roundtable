import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const guide = readFileSync(join(root, "docs/plugins.md"), "utf8");
const files = readdirSync(import.meta.dir).filter((name) =>
	name.endsWith(".ts"),
);
const examples = files.filter(
	(name) => !name.endsWith(".test.ts") && name !== "guide.test.ts",
);

/** The guide embeds a file as a `ts` block between these two markers. */
const MARKER = /<!-- example: (\S+) -->/g;
const BLOCK =
	/<!-- example: (\S+) -->\n```ts\n([\s\S]*?)\n```\n<!-- \/example -->/g;

test("every marker in the guide wraps one ts block", () => {
	expect([...guide.matchAll(BLOCK)].length).toBe(
		[...guide.matchAll(MARKER)].length,
	);
	expect([...guide.matchAll(MARKER)].length).toBeGreaterThan(0);
});

test("every block in the guide is exactly the file it names", () => {
	for (const [, path, embedded] of guide.matchAll(BLOCK)) {
		const file = readFileSync(join(root, path as string), "utf8");
		expect({ path, code: embedded }).toEqual({ path, code: file.trimEnd() });
	}
});

test("every example is embedded in the guide and has a test beside it", () => {
	const embedded = [...guide.matchAll(MARKER)].map((match) => match[1]);
	for (const name of examples) {
		expect(embedded).toContain(`examples/${name}`);
		expect(files).toContain(name.replace(/\.ts$/, ".test.ts"));
	}
});

test("examples import only the public entries, typebox, bun, and their neighbors", () => {
	for (const name of files.filter((file) => file !== "guide.test.ts")) {
		const source = readFileSync(join(import.meta.dir, name), "utf8");
		for (const [, specifier] of source.matchAll(/from "([^"]+)"/g))
			expect({ name, specifier }).toEqual({
				name,
				specifier: expect.stringMatching(
					/^(pi-roundtable|pi-roundtable\/testing|typebox|bun|bun:test|\.\/[a-z-]+\.ts)$/,
				),
			});
	}
});
