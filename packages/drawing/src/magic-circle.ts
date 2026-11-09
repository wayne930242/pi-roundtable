import {
	type Background,
	circle,
	type Point,
	path,
	polar,
	surface,
} from "./draw-kit.ts";
import { DrawingError } from "./errors.ts";
import { font, PALETTE } from "./style.ts";

export type CircleType = "pentagram" | "hexagram" | "tree_of_life" | "custom";
export type CircleStyle = "traditional" | "modern" | "geometric";

export interface CircleOptions {
	type: CircleType;
	size: 512 | 1024 | 2048;
	style: CircleStyle;
	background: Background;
	/** Up to four of fire, air, water, earth, placed north, east, south, west. */
	elements?: readonly string[];
	/** Written once around the perimeter. */
	text?: string;
}

const ELEMENT_SYMBOLS: Readonly<Record<string, string>> = {
	fire: "▲",
	air: "△",
	water: "▽",
	earth: "▼",
};

const SEPHIROT_LAYOUT: readonly Point[] = [
	[1 / 2, 1 / 6],
	[1 / 3, 1 / 3],
	[2 / 3, 1 / 3],
	[1 / 3, 1 / 2],
	[2 / 3, 1 / 2],
	[1 / 2, 3 / 5],
	[1 / 3, 3 / 4],
	[2 / 3, 3 / 4],
	[1 / 2, 5 / 6],
	[1 / 2, 11 / 12],
];

const SEPHIROT_PATHS: readonly (readonly [number, number])[] = [
	[0, 1],
	[0, 2],
	[1, 2],
	[1, 3],
	[2, 4],
	[3, 4],
	[3, 5],
	[4, 5],
	[3, 6],
	[4, 7],
	[5, 6],
	[5, 7],
	[5, 8],
	[6, 7],
	[6, 8],
	[7, 8],
	[8, 9],
];

export const CIRCLE_TYPES = [
	"pentagram",
	"hexagram",
	"tree_of_life",
	"custom",
] as const;
export const MAX_CIRCLE_TEXT = 60;
const ELEMENTS = Object.keys(ELEMENT_SYMBOLS);

export function renderMagicCircle(options: CircleOptions): Uint8Array {
	if (options.text && [...options.text].length > MAX_CIRCLE_TEXT)
		throw new DrawingError(
			`The rim text is over ${MAX_CIRCLE_TEXT} characters. Shorten it.`,
		);
	if (options.elements) {
		if (options.elements.length > 4)
			throw new DrawingError(
				"At most four elements fit, one for each quarter. Give four or fewer.",
			);
		for (const element of options.elements)
			if (!ELEMENTS.includes(element.toLowerCase()))
				throw new DrawingError(
					`Unknown element ${JSON.stringify(element)}. Use ${ELEMENTS.join(", ")}.`,
				);
	}
	const s = surface(options.size, options.background);
	const { ctx, size } = s;
	const scale = size / 512;
	const c = size / 2;
	// Rim text sits between two rings, so the figure shrinks to make room for it.
	const radius = c - (options.text ? 48 : 20) * scale;
	ctx.strokeStyle = s.line;
	ctx.lineWidth =
		(options.style === "traditional" ? 3 : options.style === "modern" ? 2 : 1) *
		scale;
	if (options.text) circle(ctx, c, c, c - 12 * scale);

	if (options.type === "tree_of_life") {
		ctx.lineWidth = 2 * scale;
		const points = SEPHIROT_LAYOUT.map(([x, y]): Point => [x * size, y * size]);
		for (const [from, to] of SEPHIROT_PATHS) {
			const a = points[from];
			const b = points[to];
			if (a && b) path(ctx, [a, b]);
		}
		for (const [x, y] of points) {
			ctx.fillStyle =
				options.background === "dark" ? PALETTE.background : "#ffffff";
			ctx.beginPath();
			ctx.arc(x, y, size / 20, 0, Math.PI * 2);
			if (options.background !== "transparent") ctx.fill();
			ctx.stroke();
		}
	} else if (options.type === "hexagram") {
		circle(ctx, c, c, radius);
		for (const offset of [-Math.PI / 2, Math.PI / 2]) {
			const triangle = [0, 1, 2].map((i) =>
				polar(c, c, radius * 0.8, (i * 2 * Math.PI) / 3 + offset),
			);
			path(ctx, triangle, true);
		}
	} else {
		// A pentagram, also the fallback for custom.
		circle(ctx, c, c, radius);
		const points = [0, 1, 2, 3, 4].map((i) =>
			polar(c, c, radius, (i * 2 * Math.PI) / 5 - Math.PI / 2),
		);
		for (let i = 0; i < 5; i++) {
			const a = points[i];
			const b = points[(i + 2) % 5];
			if (a && b) path(ctx, [a, b]);
		}
		if (options.style === "traditional") circle(ctx, c, c, radius * 0.3);
	}

	ctx.fillStyle = s.line;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	if (options.text) {
		const chars = [...options.text];
		ctx.font = font(Math.round(18 * scale));
		const textRadius = c - 30 * scale;
		chars.forEach((char, i) => {
			const [x, y] = polar(
				c,
				c,
				textRadius,
				(i * 2 * Math.PI) / chars.length - Math.PI / 2,
			);
			ctx.fillText(char, x, y);
		});
	}
	if (options.elements) {
		ctx.font = font(Math.round(24 * scale));
		const quarters: readonly Point[] = [
			[c, c - size / 3],
			[c + size / 3, c],
			[c, c + size / 3],
			[c - size / 3, c],
		];
		options.elements.slice(0, 4).forEach((element, i) => {
			const symbol = ELEMENT_SYMBOLS[element.toLowerCase()];
			const at = quarters[i];
			if (symbol && at) ctx.fillText(symbol, at[0], at[1]);
		});
	}
	return s.png();
}

// --- Sigils ---
