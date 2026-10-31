import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The page's base `button:hover` paints the accent behind a button and leaves its text colour
// alone. A button that draws its own quiet look (its own background or text colour) must say what
// hover does to it, or a tap leaves accent text on an accent fill that cannot be read (a phone
// keeps the hover after a tap).

const here = import.meta.dir;
const walk = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
	);
const files = walk(here).filter((file) => !/\.test\.tsx?$/.test(file));

/** Every stylesheet of the page: the CSS files, and the lazy styles kept in template strings. */
const css = files
	.flatMap((file) => {
		const text = readFileSync(file, "utf8");
		if (file.endsWith(".css")) return [text];
		if (!/\.tsx?$/.test(file)) return [];
		return [...text.matchAll(/_CSS = `([^`]*)`/g)].map(
			(match) => match[1] ?? "",
		);
	})
	.join("\n")
	.replace(/\/\*[\s\S]*?\*\//g, "");

const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
	selectors: (match[1] ?? "").split(",").map((one) => one.trim()),
	body: match[2] ?? "",
}));

/** The class lists of every `<button>` the page draws with a literal className. */
const buttons = files
	.filter((file) => file.endsWith(".tsx"))
	.flatMap((file) =>
		[
			...readFileSync(file, "utf8").matchAll(
				/<button\b[^>]*?className=\{?["'`]([^"'`}$]+)["'`]/g,
			),
		].map((match) => (match[1] ?? "").split(/\s+/).filter(Boolean)),
	);

const ends = (name: string) => new RegExp(`\\.${name}(?![\\w-])`);
/** The class's own look: a selector naming it without a state, setting a fill or a text colour. */
const quiet = (name: string) =>
	rules.some(
		({ selectors, body }) =>
			selectors.some(
				(selector) =>
					ends(name).test(selector) &&
					!/[:[]/.test(selector.slice(selector.search(ends(name)))) &&
					!/\s/.test(selector.slice(selector.search(ends(name)))),
			) && /(^|[;\s])(background(-color)?|color)\s*:/.test(body),
	);
/** Whether some rule says what hover does to the class's fill. */
const hovers = (name: string) =>
	rules.some(
		({ selectors, body }) =>
			selectors.some((selector) =>
				new RegExp(`\\.${name}(?![\\w-])[^\\s]*:hover`).test(selector),
			) && /(^|[;\s])background(-color)?\s*:/.test(body),
	);

test("a button with a quiet look of its own says what hover does to its fill", () => {
	expect(buttons.length).toBeGreaterThan(20);
	const unreadable = buttons
		.filter((classes) => classes.some(quiet) && !classes.some(hovers))
		.map((classes) => classes.join(" "));
	expect([...new Set(unreadable)]).toEqual([]);
});
