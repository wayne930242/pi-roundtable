import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A phone zooms the page when a text control below 16px takes focus. A control inherits its font
// from the label around it (13px), so this reads the page's styles, and not a rendered page, to keep
// every text input, textarea and select at 16px or more at phone widths.

const here = import.meta.dir;

interface Rule {
	selector: string;
	body: string;
	media: string;
}

/** Splits CSS text into its style rules, each with the at-rule condition around it. */
function rules(source: string, media = ""): Rule[] {
	const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
	const out: Rule[] = [];
	let index = 0;
	while (index < text.length) {
		const open = text.indexOf("{", index);
		if (open < 0) break;
		const head = text.slice(index, open).trim();
		let depth = 1;
		let close = open + 1;
		while (close < text.length && depth > 0) {
			if (text[close] === "{") depth++;
			else if (text[close] === "}") depth--;
			close++;
		}
		const inner = text.slice(open + 1, close - 1);
		if (head.startsWith("@media")) {
			out.push(...rules(inner, `${media} ${head.slice(6)}`.trim()));
		} else if (head.startsWith("@")) {
			if (!head.startsWith("@keyframes")) out.push(...rules(inner, media));
		} else out.push({ selector: head, body: inner, media });
		index = close;
	}
	return out;
}

/** Whether the rule applies at phone widths: no condition, or one for narrow or touch screens. */
const onPhone = (media: string): boolean =>
	media === "" ||
	(!/min-width/.test(media) &&
		/max-width:\s*(\d+)px|pointer:\s*coarse/.test(media));

const webFiles = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? entry.name === "node_modules"
				? []
				: webFiles(join(dir, entry.name))
			: [join(dir, entry.name)],
	);

/** Every style rule the page ships: the stylesheets, and the CSS text the lazy chunks install. */
function allRules(): Rule[] {
	return webFiles(here)
		.filter((file) => !/\.test\.tsx?$/.test(file))
		.flatMap((file) => {
			const text = readFileSync(file, "utf8");
			if (file.endsWith(".css")) return rules(text);
			if (!/\.tsx?$/.test(file)) return [];
			return [...text.matchAll(/`([^`]*)`/g)]
				.map((found) => found[1] ?? "")
				.filter((chunk) => /\{[^}]*:[^}]*\}/.test(chunk))
				.flatMap((chunk) => rules(chunk.replace(/\$\{[^}]*\}/g, "0")));
		});
}

/** Pixels of a font-size value, or undefined when it cannot be told (a keyword or an unknown variable). */
function pixels(value: string): number | undefined {
	const tokens: Record<string, number> = {
		"--text-xs": 12,
		"--text-sm": 13,
		"--text-base": 15,
		"--text-md": 16,
		"--text-lg": 18,
		"--text-xl": 22,
		"--text-2xl": 28,
	};
	const variable = /^var\((--[\w-]+)\)$/.exec(value);
	if (variable) return tokens[variable[1] ?? ""];
	const rem = /^([\d.]+)rem$/.exec(value);
	if (rem) return Number(rem[1]) * 16;
	const px = /^([\d.]+)px$/.exec(value);
	if (px) return Number(px[1]);
	return undefined;
}

const fontSize = (body: string): string | undefined =>
	[...body.matchAll(/(?:^|[;\s])font-size:\s*([^;}]+)/g)].at(-1)?.[1]?.trim();

/** The last compound of a selector: what the rule styles. */
const subject = (selector: string): string =>
	selector
		.trim()
		.split(/[\s>+~]+/)
		.at(-1) ?? "";

const NOT_TEXT = /\[type=["']?(checkbox|radio|range|color|file|hidden)/;

/** The element names and classes a rule's subject styles when it is a text control, or undefined. */
function controlOf(
	compound: string,
): { tag?: string; classes: string[] } | undefined {
	const tag = /^(input|select|textarea)(?![\w-])/.exec(compound)?.[1];
	if (tag && NOT_TEXT.test(compound)) return undefined;
	return {
		...(tag ? { tag } : {}),
		classes: [...compound.matchAll(/\.([\w-]+)/g)].map((m) => m[1] ?? ""),
	};
}

/** The classes put on a text control in the page's components. */
function controlClasses(): Set<string> {
	const found = new Set<string>();
	for (const file of webFiles(here)) {
		if (!file.endsWith(".tsx") || file.endsWith(".test.tsx")) continue;
		const text = readFileSync(file, "utf8");
		for (const tag of text.matchAll(
			/<(input|textarea|select)\b([^<>]*?)(?:\/>|>)/gs,
		)) {
			const type = /type=["'](\w+)["']/.exec(tag[2] ?? "")?.[1] ?? "text";
			if (/^(checkbox|radio|range|color|file|hidden)$/.test(type)) continue;
			for (const name of /className=["']([^"']+)["']/
				.exec(tag[2] ?? "")?.[1]
				?.split(/\s+/) ?? [])
				found.add(name);
		}
	}
	return found;
}

test("every rule that sets the size of a text control gives 16px or more at phone widths", () => {
	const classes = controlClasses();
	// The later rule of one selector wins, so a narrow-screen rule that follows its base rule counts.
	const last = new Map<string, { one: string; rule: Rule }>();
	for (const rule of allRules().filter((one) => onPhone(one.media)))
		for (const one of rule.selector.split(",").map((part) => part.trim()))
			if (fontSize(rule.body) !== undefined) last.set(one, { one, rule });
	const small = [...last.values()]
		.filter(({ one, rule }) => {
			const size = fontSize(rule.body);
			if (size === undefined) return false;
			const control = controlOf(subject(one));
			if (!control) return false;
			const ofControl =
				control.tag !== undefined ||
				control.classes.some((name) => classes.has(name));
			if (!ofControl) return false;
			const value = pixels(size);
			return value !== undefined && value < 16;
		})
		.map(({ one, rule }) => `${one} { font-size: ${fontSize(rule.body)} }`);
	expect(small).toEqual([]);
});

test("the shared form rules say it for every text control, as a label's own 13px reaches the control otherwise", () => {
	const rule = rules(readFileSync(join(here, "styles.css"), "utf8")).find(
		(one) =>
			onPhone(one.media) &&
			one.media !== "" &&
			/\bselect\b/.test(one.selector) &&
			/\btextarea\b/.test(one.selector) &&
			/\binput\b/.test(one.selector) &&
			fontSize(one.body) !== undefined,
	);
	expect(rule).toBeDefined();
	expect(pixels(fontSize(rule?.body ?? "") ?? "")).toBeGreaterThanOrEqual(16);
	// Checkboxes and radios are not text, and keep their own size.
	expect(rule?.selector).toContain("checkbox");
	expect(rule?.selector).toContain("radio");
});
