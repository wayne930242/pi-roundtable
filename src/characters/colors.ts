import type { CharacterLook } from "./compose.ts";
import type { Hex } from "./spec.ts";

type Rgb = readonly [number, number, number];

const channel = (value: number): string =>
	Math.max(0, Math.min(255, Math.round(value)))
		.toString(16)
		.padStart(2, "0");

function rgbOf(color: string): Rgb {
	const part = (at: number) => Number.parseInt(color.slice(at, at + 2), 16);
	return [part(1), part(3), part(5)];
}

function hexOf([r, g, b]: Rgb): Hex {
	return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** The point `t` of the way from `a` to `b`, channel by channel. */
export function mix(a: string, b: string, t: number): Hex {
	const from = rgbOf(a);
	const to = rgbOf(b);
	return hexOf([
		from[0] + (to[0] - from[0]) * t,
		from[1] + (to[1] - from[1]) * t,
		from[2] + (to[2] - from[2]) * t,
	]);
}

export const lighten = (color: string, t: number): Hex =>
	mix(color, "#ffffff", t);
export const darken = (color: string, t: number): Hex =>
	mix(color, "#1a1330", t);

function luminance(color: string): number {
	const [r, g, b] = rgbOf(color).map((value) => {
		const unit = value / 255;
		return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio of two colors, 1 to 21. */
export function contrast(a: string, b: string): number {
	const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
		number,
		number,
	];
	return (light + 0.05) / (dark + 0.05);
}

/**
 * The surface the accent sits on, per scheme and per look: the app's page background, and for
 * Camelot the hardest of its surfaces (the darkest parchment, the lightest night blue), so a
 * shade that reads on that one reads on the rest.
 */
const SURFACE = {
	light: "#ffffff",
	dark: "#0d1018",
	"modern-light": "#ffffff",
	"modern-dark": "#0d1018",
	"camelot-light": "#e3d2a9",
	"camelot-dark": "#243557",
} as const;

/**
 * `primary` itself when it reads at 3:1 on the surface, else the first shade toward the opposite
 * end (darker on a light surface, lighter on a dark one) that does.
 */
export function accentColor(
	primary: Hex,
	on: "light" | "dark" | CharacterLook,
): Hex {
	const surface = SURFACE[on];
	const toward = on.endsWith("light") ? "#1a1330" : "#ffffff";
	for (let step = 0; step <= 20; step++) {
		const shade = step === 0 ? primary : mix(primary, toward, step / 20);
		if (contrast(shade, surface) >= 3) return shade;
	}
	return toward as Hex;
}

/** Every color a part may use, as literals: nothing in the output refers to a variable. */
export interface Tones {
	/** Primary and its shades. */
	p: string;
	pd: string;
	pl: string;
	pll: string;
	/** Secondary tincture. */
	s: string;
	sd: string;
	/** Metal trim. */
	t: string;
	td: string;
	/** Skin. */
	k: string;
	kd: string;
	/** Hair. */
	hr: string;
	hd: string;
	ink: string;
	/** Prop glow. */
	gl: string;
}

export type Part = (tones: Tones) => string;
