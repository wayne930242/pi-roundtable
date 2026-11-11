import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Every form control of the page is drawn by a shared component, so a kind of control has one
// look and one place to change. This reads the page's sources, and not a rendered page: a control
// written by hand in one more file is what it catches.

const here = import.meta.dir;

/** The page's components and pages, by their path under `web/`; the tests draw what they like. */
const sources = (dir: string = here): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? sources(join(dir, entry.name))
			: entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")
				? [relative(here, join(dir, entry.name)).split(sep).join("/")]
				: [],
	);

/** The shared components, which write the native controls. */
const SHARED = ["components/fields.tsx", "components/select.tsx"];

/**
 * The two files of the page's first chunk that draw a control, which keep their own: a room's
 * composer (its text box and its hidden file picker) and its question cards. They are drawn
 * before any lazy part loads, and a shared component there would be bytes of the first load,
 * which has none to spare (`src/page.test.ts` holds the budget; the bare controls alone measured
 * 22 bytes gzipped). They take the page's own look, with no size, tone or variant.
 */
const FIRST_CHUNK = [
	"components/cards-questions.tsx",
	"components/composer.tsx",
];

/** Each line of a file that writes a native control. */
const written = (file: string): string[] =>
	readFileSync(join(here, file), "utf8")
		.split("\n")
		.flatMap((line, index) =>
			/<(input|select|textarea)(?![\w-])/.test(line)
				? [`${file}:${index + 1}: ${line.trim()}`]
				: [],
		);

test("no page or component writes an <input>, a <select> or a <textarea> of its own: each control is a shared component", () => {
	const bare = sources()
		.filter((file) => !SHARED.includes(file) && !FIRST_CHUNK.includes(file))
		.flatMap(written);
	expect(bare).toEqual([]);
});

test("the first chunk's own controls are the seven it has today, so one more is a choice and not a slip", () => {
	expect(
		FIRST_CHUNK.flatMap(written).map((line) => line.replace(/:\d+:/, ":")),
	).toEqual([
		"components/cards-questions.tsx: <textarea",
		"components/cards-questions.tsx: <input",
		"components/cards-questions.tsx: <input",
		"components/cards-questions.tsx: <input",
		"components/cards-questions.tsx: <textarea",
		"components/composer.tsx: <input",
		"components/composer.tsx: <textarea",
	]);
});

test("the first chunk does not take the shared fields, whose stylesheet and looks load with the lazy parts", () => {
	for (const file of FIRST_CHUNK)
		expect(readFileSync(join(here, file), "utf8")).not.toMatch(
			/from "[^"]*\/(fields|select|search-field|time-range|radio-group)\.tsx"/,
		);
});

test("the drop-down is taken from fields.tsx like every other control, which keeps them one lazy chunk", () => {
	const users = sources().filter((file) =>
		/from "[^"]*\/select\.tsx"/.test(readFileSync(join(here, file), "utf8")),
	);
	expect(users).toEqual(["components/fields.tsx"]);
});

test("the shared components are where the native controls are written", () => {
	const text = (file: string) => readFileSync(join(here, file), "utf8");
	expect(text("components/fields.tsx")).toMatch(/<input \{/);
	expect(text("components/fields.tsx")).toMatch(/<textarea \{/);
	expect(text("components/select.tsx")).toMatch(/<select \{/);
});
