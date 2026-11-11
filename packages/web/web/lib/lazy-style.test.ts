import { afterAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { installStyle } from "./lazy-style.ts";

afterAll(async () => {
	if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

const count = () =>
	(document.adoptedStyleSheets?.length ?? 0) +
	[...document.querySelectorAll("style")].filter((one) =>
		one.textContent?.includes(".lazy-probe"),
	).length;

test("a style goes in once per document, and a new document takes it again", async () => {
	if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
	GlobalRegistrator.register({ url: "http://localhost/" });
	installStyle("lazy-probe", ".lazy-probe { color: red }");
	installStyle("lazy-probe", ".lazy-probe { color: red }");
	expect(count()).toBe(1);
	// The next test file's page is a new document; the style an earlier one took is not in it.
	await GlobalRegistrator.unregister();
	GlobalRegistrator.register({ url: "http://localhost/" });
	installStyle("lazy-probe", ".lazy-probe { color: red }");
	expect(count()).toBe(1);
});

test("each style has an id of its own: a second style under one id would never be installed", () => {
	const web = join(import.meta.dir, "..");
	const sources = (dir: string): string[] =>
		readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
			entry.isDirectory()
				? sources(join(dir, entry.name))
				: /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
					? [join(dir, entry.name)]
					: [],
		);
	// Each id with the styles installed under it, a style being the constant of one file or a text written in place.
	const styles = new Map<string, Set<string>>();
	for (const file of sources(web))
		for (const call of readFileSync(file, "utf8").matchAll(
			/installStyle\(\s*"([\w-]+)",\s*(\w+|`)/g,
		)) {
			const id = call[1] ?? "";
			styles.set(
				id,
				(styles.get(id) ?? new Set()).add(`${relative(web, file)}: ${call[2]}`),
			);
		}
	expect(styles.size).toBeGreaterThan(20);
	const shared = [...styles]
		.filter(([, under]) => under.size > 1)
		.map(([id, under]) => `${id}: ${[...under].join(", ")}`);
	expect(shared).toEqual([]);
});
