import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { contrast, lightDarkTokens } from "./contrast-fixture.ts";

const css = readFileSync(
	new URL("./styles/camelot.css", import.meta.url),
	"utf8",
);

/** The Camelot tokens: each `--name: light-dark(#light, #dark)` of the look's root block. */
const tokens = () =>
	lightDarkTokens(css, /:root\[data-look="camelot"\]\s*{([^}]*)}/);

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
