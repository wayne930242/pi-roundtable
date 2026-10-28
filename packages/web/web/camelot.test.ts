import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(
	new URL("./styles/camelot.css", import.meta.url),
	"utf8",
);

/** The WCAG contrast ratio of two `#rrggbb` colours. */
function contrast(a: string, b: string): number {
	const luminance = (hex: string) => {
		const [r, g, b2] = [1, 3, 5].map((at) => {
			const unit = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
			return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
		}) as [number, number, number];
		return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
	};
	const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
		number,
		number,
	];
	return (light + 0.05) / (dark + 0.05);
}

/** The Camelot tokens: each `--name: light-dark(#light, #dark)` of the look's root block. */
function tokens(): Record<string, { light: string; dark: string }> {
	const block = /:root\[data-look="camelot"\]\s*{([^}]*)}/.exec(css)?.[1];
	if (!block) throw new Error("no Camelot token block");
	const found: Record<string, { light: string; dark: string }> = {};
	for (const match of block.matchAll(
		/--([a-z0-9-]+):\s*light-dark\(\s*(#[0-9a-f]{6})\s*,\s*(#[0-9a-f]{6})\s*\)/g,
	)) {
		const [, name, light, dark] = match;
		if (name && light && dark) found[name] = { light, dark };
	}
	return found;
}

const SURFACES = [
	"bg",
	"surface",
	"surface-2",
	"surface-3",
	"raised",
	"gold-wash",
];

function check(
	foreground: string,
	backgrounds: readonly string[],
	least: number,
): void {
	const all = tokens();
	for (const scheme of ["light", "dark"] as const)
		for (const background of backgrounds) {
			const fg = all[foreground]?.[scheme];
			const bg = all[background]?.[scheme];
			if (!fg || !bg)
				throw new Error(`no token ${foreground} or ${background}`);
			const ratio = contrast(fg, bg);
			if (ratio < least)
				throw new Error(
					`${foreground} on ${background} (${scheme}) is ${ratio.toFixed(2)}:1, under ${least}:1`,
				);
		}
}

test("Camelot's page colours are the spec's parchment and night castle", () => {
	const all = tokens();
	expect(all.bg).toEqual({ light: "#f4ead5", dark: "#0f1726" });
	expect(all.surface).toEqual({ light: "#fbf5e6", dark: "#16213a" });
	expect(all.text).toEqual({ light: "#2b2118", dark: "#efe6d2" });
	expect(all.gold).toEqual({ light: "#b98a2c", dark: "#e6b94c" });
});

test("every text colour of the Camelot look reads at 4.5:1 on the surfaces it sits on, in both schemes", () => {
	check("text", SURFACES, 4.5);
	check("muted", SURFACES, 4.5);
	check("accent", SURFACES, 4.5);
	check("accent-ink", [...SURFACES, "accent-soft"], 4.5);
	check("on-accent", ["accent"], 4.5);
	for (const meaning of ["success", "warn", "danger", "yolo", "long"])
		check(meaning, [...SURFACES, `${meaning}-soft`], 4.5);
});

test("the edge of a control and the focus colour read at 3:1 against the surfaces", () => {
	check("control-border", ["bg", "surface", "raised"], 3);
	check("accent", SURFACES, 3);
});
