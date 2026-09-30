import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { useTestLocale } from "../testing/locale.ts";
import { createEn } from "./en.ts";
import { LOCALES, type Messages, messages, setLocale } from "./index.ts";
import { createZhTW } from "./zh-tw.ts";

const CTX = { assistant: "Roundtable", root: "roundtable" };
const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;

type Entry = string | ((...args: never[]) => unknown);

/** Calls a message function with plain arguments of one shape; the first shape it accepts wins. */
function render(entry: (...values: unknown[]) => unknown): string {
	for (const arg of ["x", ["x"], 1, { x: "x" }]) {
		try {
			return JSON.stringify(
				entry(...Array.from({ length: entry.length }, () => arg)),
			);
		} catch {
			// Try the next shape.
		}
	}
	throw new Error(`no plain arguments fit ${entry.toString().slice(0, 60)}`);
}

/** Every entry of a catalog as text: a string as it is, a function called with plain arguments. */
function rendered(catalog: Messages): [string, string][] {
	return Object.entries(catalog as Record<string, unknown>).map(
		([key, entry]) => [
			key,
			typeof entry === "string"
				? entry
				: typeof entry === "function"
					? render(entry as (...values: unknown[]) => unknown)
					: JSON.stringify(entry),
		],
	);
}

const kind = (entry: unknown): string =>
	typeof entry === "function" ? `function/${entry.length}` : typeof entry;

afterEach(() => {
	useTestLocale();
});

describe("catalogs", () => {
	test("the English and Traditional Chinese catalogs have the same keys, and functions the same arity", () => {
		const en = createEn(CTX) as Record<string, Entry>;
		const zh = createZhTW(CTX) as Record<string, Entry>;
		expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
		const shapes = (catalog: Record<string, Entry>) =>
			Object.fromEntries(
				Object.entries(catalog).map(([key, entry]) => [key, kind(entry)]),
			);
		expect(shapes(zh)).toEqual(shapes(en));
	});

	test("the English catalog has no Chinese text or fullwidth punctuation", () => {
		const offenders = rendered(createEn(CTX))
			.filter(([, text]) => CJK.test(text))
			.map(([key]) => key);
		expect(offenders).toEqual([]);
	});

	test("the Traditional Chinese catalog is not the English one", () => {
		const en = new Map(rendered(createEn(CTX)));
		const same = rendered(createZhTW(CTX)).filter(
			([key, text]) => en.get(key) === text,
		);
		// A few entries are the same in both languages, such as a bare command name.
		expect(same.length).toBeLessThan(en.size / 5);
	});
});

describe("setLocale", () => {
	test("names the assistant and the root command in the text", () => {
		setLocale("en", { assistant: "Robin", root: "robin" });
		const text = JSON.stringify(rendered(messages()));
		expect(text).toContain("Robin");
		expect(text).toContain("/robin");
		expect(text).not.toContain("Roundtable");
	});

	test("shows English by default-style settings and Chinese for zh-TW", () => {
		setLocale("en", CTX);
		expect(messages().stopLabel).toBe("Stop");
		setLocale("zh-TW", CTX);
		expect(messages().stopLabel).toBe("停止");
	});

	test("an override replaces one message and leaves the others", () => {
		setLocale("en", { ...CTX, overrides: { stopLabel: "Halt" } });
		expect(messages().stopLabel).toBe("Halt");
		expect(messages().ownerFailedTitle).toBe("Could not complete");
	});

	test("an unknown locale is refused", () => {
		expect(() => setLocale("fr" as never, CTX)).toThrow("Unknown locale: fr");
		expect(LOCALES).toEqual(["en", "zh-TW"]);
	});
});

describe("what the core shows", () => {
	const files = (root: string, pattern: string) =>
		[...new Glob(pattern).scanSync({ cwd: root })].map((f) => join(root, f));

	test("no Chinese text outside the catalogs and the tests", () => {
		const offenders = files("src/core", "**/*.ts")
			.filter((f) => !f.includes("/i18n/") && !/\.test\.ts$/.test(f))
			.flatMap((f) =>
				readFileSync(f, "utf8")
					.split("\n")
					.map((line, index) => ({ f, line, index }))
					// Regexes may match fullwidth punctuation; only ideographs are text.
					.filter(({ line }) => /[\u3400-\u9fff]/.test(line))
					.map(({ f: file, index }) => `${file}:${index + 1}`),
			);
		expect(offenders).toEqual([]);
	});

	test("no source in the core names its first consumer", () => {
		// Spelled in pieces so this test does not itself name the consumer.
		const consumer = new RegExp(["mer", "lin"].join(""), "i");
		const offenders = files("src/core", "**/*.ts")
			.filter((f) => !/\.test\.ts$/.test(f) && !f.includes("/testing/"))
			.flatMap((f) =>
				readFileSync(f, "utf8")
					.split("\n")
					.map((line, index) => ({ f, line, index }))
					.filter(({ line }) => consumer.test(line))
					.map(({ f: file, index }) => `${file}:${index + 1}`),
			);
		expect(offenders).toEqual([]);
	});
});
