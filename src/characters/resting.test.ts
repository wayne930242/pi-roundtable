import { expect, test } from "bun:test";
import {
	characterCss,
	composeSvg,
	EXPRESSIONS,
	resolveCharacter,
	STATE_EXPRESSION,
} from "./index.ts";

const KNIGHT = resolveCharacter({ class: "knight" });
const part = (svg: string, name: string) =>
	svg.match(new RegExp(`<g class="${name}"[^>]*>.*?</g>`))?.[0] ?? "";

test("resting is a calm face with closed eyes, and the state's own expression stays as it was", () => {
	expect(EXPRESSIONS).toContain("resting");
	// The kit's states keep their expressions: only the chat home asks for the resting face.
	expect(STATE_EXPRESSION.idle).toBe("neutral");
	const resting = composeSvg(KNIGHT, { expr: "resting", uid: "r1" });
	const neutral = composeSvg(KNIGHT, { expr: "neutral", uid: "r1" });
	expect(resting).toContain('data-expr="resting"');
	// Closed eyes are strokes; an open eye is a filled ellipse with a catch-light.
	expect(part(resting, "eyes")).toContain("<path");
	expect(part(resting, "eyes")).not.toContain("<ellipse");
	expect(part(neutral, "eyes")).toContain("<ellipse");
});

test("a resting face differs from a sleepy one: no yawn, no brows drawn down, no drowsy overlay on show", () => {
	const resting = composeSvg(KNIGHT, { expr: "resting", uid: "r2" });
	const sleepy = composeSvg(KNIGHT, { expr: "sleepy", uid: "r2" });
	expect(part(resting, "eyes")).toBe(part(sleepy, "eyes"));
	expect(part(resting, "mouth")).not.toBe(part(sleepy, "mouth"));
	expect(part(resting, "brows")).not.toBe(part(sleepy, "brows"));
	expect(resting).not.toBe(sleepy);
	// A resting figure is the idle state: its stylesheet shows no zz, the sleepy state's does.
	const css = characterCss();
	expect(css).toContain("[data-state=sleepy] .o-zz{opacity:1");
	expect(css).not.toContain("[data-state=idle] .o-zz");
});

test("the blink of the other expressions is offset by the figure's --phase, and a resting face does not blink", () => {
	const css = characterCss();
	const blink = css.match(/\.av \.eyes\{[^}]*\}/)?.[0] ?? "";
	expect(blink).toContain("animation:av-blink 5.2s");
	expect(blink).toMatch(/var\(--phase,\s*0s\)/);
	expect(css).toContain(".av[data-expr=resting] .eyes{animation:none}");
	// Reduced motion still stops every loop.
	expect(css).toContain(
		"@media (prefers-reduced-motion:reduce){.av *{animation:none!important}",
	);
});
