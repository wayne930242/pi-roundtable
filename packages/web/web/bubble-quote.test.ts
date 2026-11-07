import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { contrast, lightDarkTokens, over } from "./contrast-fixture.ts";

const read = (path: string) =>
	readFileSync(new URL(path, import.meta.url), "utf8");
const app = read("./app.css");

const LOOKS = {
	modern: lightDarkTokens(read("./tokens.css"), /:root\s*{([^}]*)}/),
	camelot: lightDarkTokens(
		read("./styles/camelot.css"),
		/:root\[data-look="camelot"\]\s*{([^}]*)}/,
	),
};

/** The fill under a quote and inline code in one's own bubble, per scheme: black or white at an alpha. */
function quoteFill(): Record<
	"light" | "dark",
	{ color: string; alpha: number }
> {
	const rule =
		/\.message\[data-mine\] \.prose code,\s*\.message\[data-mine\] \.prose blockquote\s*{\s*background:\s*light-dark\(\s*rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\),\s*rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)\s*\)/.exec(
			app,
		);
	if (!rule) throw new Error("no quote fill for one's own bubble");
	const hex = (channels: string[]) =>
		`#${channels.map((c) => Number(c).toString(16).padStart(2, "0")).join("")}`;
	return {
		light: { color: hex(rule.slice(1, 4)), alpha: Number(rule[4]) },
		dark: { color: hex(rule.slice(5, 8)), alpha: Number(rule[8]) },
	};
}

test("a quote in one's own bubble keeps the bubble's text, not the page's muted grey", () => {
	expect(app).toMatch(
		/\.message\[data-mine\] \.prose blockquote\s*{\s*color:\s*inherit;/,
	);
});

test("a quote and its code read at 4.5:1 in one's own bubble, in every look and scheme", () => {
	const fill = quoteFill();
	for (const [look, all] of Object.entries(LOOKS))
		for (const scheme of ["light", "dark"] as const) {
			const bubble = all.accent?.[scheme];
			const text = all["on-accent"]?.[scheme];
			if (!bubble || !text) throw new Error(`no accent in ${look}`);
			const quote = over(fill[scheme].color, fill[scheme].alpha, bubble);
			const code = over(fill[scheme].color, fill[scheme].alpha, quote);
			for (const [what, under] of [
				["quote", quote],
				["code in a quote", code],
			] as const) {
				const ratio = contrast(text, under);
				if (ratio < 4.5)
					throw new Error(
						`${what} in ${look} (${scheme}) is ${ratio.toFixed(2)}:1, under 4.5:1`,
					);
			}
		}
});
