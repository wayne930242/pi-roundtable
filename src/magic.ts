/**
 * Magic circles, sigils, and sacred geometry, drawn with node-canvas: line art in the
 * bundled font and palette on a dark, white, or transparent ground.
 */
import { createHash } from "node:crypto";
import { type CanvasRenderingContext2D, createCanvas } from "canvas";
import { DrawingError } from "./errors.ts";
import { ensureFont, font, PALETTE } from "./style.ts";

export type Background = "dark" | "white" | "transparent";
type Point = readonly [number, number];

interface Surface {
	ctx: CanvasRenderingContext2D;
	size: number;
	line: string;
	png: () => Uint8Array;
}

function surface(size: number, background: Background): Surface {
	ensureFont();
	const canvas = createCanvas(size, size);
	const ctx = canvas.getContext("2d");
	if (background !== "transparent") {
		ctx.fillStyle = background === "dark" ? PALETTE.background : "#ffffff";
		ctx.fillRect(0, 0, size, size);
	}
	ctx.lineJoin = "round";
	ctx.lineCap = "round";
	return {
		ctx,
		size,
		line: background === "dark" ? PALETTE.accentLight : PALETTE.background,
		png: () => new Uint8Array(canvas.toBuffer("image/png")),
	};
}

function circle(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	r: number,
): void {
	ctx.beginPath();
	ctx.arc(x, y, r, 0, Math.PI * 2);
	ctx.stroke();
}

function path(
	ctx: CanvasRenderingContext2D,
	points: readonly Point[],
	close = false,
): void {
	const [first, ...rest] = points;
	if (!first) return;
	ctx.beginPath();
	ctx.moveTo(first[0], first[1]);
	for (const [x, y] of rest) ctx.lineTo(x, y);
	if (close) ctx.closePath();
	ctx.stroke();
}

/** Whether canvas accepts the text as a color: it leaves its fill alone for what it cannot parse. */
function isCssColor(value: string): boolean {
	const ctx = createCanvas(1, 1).getContext("2d");
	return ["#010203", "#040506"].some((sentinel) => {
		ctx.fillStyle = sentinel;
		ctx.fillStyle = value;
		return ctx.fillStyle !== sentinel;
	});
}

function polar(cx: number, cy: number, r: number, angle: number): Point {
	return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
}

// --- Magic circles ---

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

export type SigilMethod = "chaos" | "rose_cross" | "geometric" | "planetary";

export interface SigilOptions {
	intention: string;
	method: SigilMethod;
	complexity: "simple" | "elaborate";
	style: "traditional" | "modern";
	background: Background;
}

const SIGIL_SIZE = 512;

function letters(text: string): string[] {
	return [...text.toUpperCase()].filter((char) => /\p{L}/u.test(char));
}

function codePoint(char: string): number {
	return char.codePointAt(0) ?? 0;
}

/** A–Z keep the Golden Dawn angles; other letters, such as those of other scripts, get one from their code point. */
function roseCrossAngle(char: string): number {
	const index = codePoint(char) - 65;
	if (index >= 0 && index < 26)
		return index === 24 ? 60 : index === 25 ? 90 : (index % 12) * 30;
	return (codePoint(char) % 12) * 30;
}

function planetaryRadius(char: string): number {
	const index = codePoint(char) - 65;
	return 0.2 + ((index >= 0 && index < 26 ? index : codePoint(char)) % 7) * 0.1;
}

export function renderSigil(options: SigilOptions): Uint8Array {
	if (options.intention.trim() === "")
		throw new DrawingError("The intention is empty. Give a short phrase.");
	if (options.method !== "geometric" && letters(options.intention).length === 0)
		throw new DrawingError(
			`The ${options.method} method draws from letters, and the intention has none. Write it in words, or use the geometric method.`,
		);
	const s = surface(SIGIL_SIZE, options.background);
	const { ctx, size } = s;
	const c = size / 2;
	const elaborate = options.complexity === "elaborate";
	// A long intention spirals outward; the figure stays inside the frame.
	const reach = c - 20;
	ctx.strokeStyle = s.line;
	const thin = () => {
		ctx.lineWidth = 1;
	};
	const thick = () => {
		ctx.lineWidth = elaborate ? 3 : 2;
	};

	if (options.method === "rose_cross") {
		if (elaborate) {
			thin();
			path(ctx, [
				[20, c],
				[size - 20, c],
			]);
			path(ctx, [
				[c, 20],
				[c, size - 20],
			]);
			for (const r of [size / 6, size / 4, size / 3]) circle(ctx, c, c, r);
		}
		thick();
		const points = letters(options.intention).map((char, i) =>
			polar(
				c,
				c,
				Math.min(size / 4 + i * 10, reach),
				(roseCrossAngle(char) * Math.PI) / 180,
			),
		);
		path(ctx, points);
	} else if (options.method === "geometric") {
		const hash = createHash("md5").update(options.intention).digest("hex");
		const margin = 40;
		const points: Point[] = [];
		for (let i = 0; i < 16; i += 2) {
			const x = Number.parseInt(hash[i] ?? "8", 16) / 15;
			const y = Number.parseInt(hash[i + 1] ?? "8", 16) / 15;
			points.push([
				margin + x * (size - 2 * margin),
				margin + y * (size - 2 * margin),
			]);
		}
		thick();
		path(ctx, points, true);
		if (elaborate) {
			thin();
			const cx = points.reduce((sum, p) => sum + p[0], 0) / points.length;
			const cy = points.reduce((sum, p) => sum + p[1], 0) / points.length;
			for (const point of points) path(ctx, [point, [cx, cy]]);
		}
	} else if (options.method === "planetary") {
		if (elaborate) {
			thin();
			for (let i = 1; i < 8; i++) circle(ctx, c, c, (size / 8) * i);
		}
		thick();
		const radii = letters(options.intention).map(planetaryRadius);
		const points = radii.map((factor, i) =>
			polar(
				c,
				c,
				factor * (size / 3),
				(i * 2 * Math.PI) / Math.max(radii.length, 1),
			),
		);
		path(ctx, points, points.length > 2);
	} else {
		// Chaos method: drop repeated letters, then join what remains.
		const unique = [...new Set(letters(options.intention))];
		const points = unique.map((char, i) =>
			polar(
				c,
				c,
				Math.min((size / 3) * (0.5 + i * 0.1), reach),
				((codePoint(char) - 65) * Math.PI) / 13,
			),
		);
		thick();
		path(ctx, points, elaborate && points.length >= 3);
		if (elaborate) {
			thin();
			for (const [x, y] of points) circle(ctx, x, y, 3);
		}
	}

	if (options.style === "modern") {
		ctx.lineWidth = 2;
		ctx.strokeRect(10, 10, size - 20, size - 20);
	}
	return s.png();
}

// --- Sacred geometry ---

export type GeometryPattern =
	| "flower_of_life"
	| "metatron"
	| "sri_yantra"
	| "vesica_pisces";

export interface GeometryOptions {
	pattern: GeometryPattern;
	layers: number;
	rotation: number;
	/** CSS colors cycled per layer; the palette's line color when empty. */
	colors: readonly string[];
	background: Background;
}

const GEOMETRY_SIZE = 1024;

function rotate(points: readonly Point[], c: number, degrees: number): Point[] {
	const r = (degrees * Math.PI) / 180;
	return points.map(([x, y]) => [
		c + (x - c) * Math.cos(r) - (y - c) * Math.sin(r),
		c + (x - c) * Math.sin(r) + (y - c) * Math.cos(r),
	]);
}

export const MAX_LAYERS = 9;

export function renderSacredGeometry(options: GeometryOptions): Uint8Array {
	if (
		!Number.isInteger(options.layers) ||
		options.layers < 1 ||
		options.layers > MAX_LAYERS
	)
		throw new DrawingError(
			`layers must be a whole number from 1 to ${MAX_LAYERS}; got ${options.layers}.`,
		);
	if (!Number.isFinite(options.rotation))
		throw new DrawingError("rotation must be a number of degrees.");
	if (options.colors.length > MAX_LAYERS)
		throw new DrawingError(
			`At most ${MAX_LAYERS} colors are used, one for each layer. Give fewer.`,
		);
	for (const color of options.colors)
		if (!isCssColor(color))
			throw new DrawingError(
				`${JSON.stringify(color)} is not a CSS color. Use a name such as gold or a code such as #c0a060.`,
			);
	const s = surface(GEOMETRY_SIZE, options.background);
	const { ctx, size } = s;
	const c = size / 2;
	const colors = options.colors.length > 0 ? options.colors : [s.line];
	const color = (i: number) => colors[i % colors.length] ?? s.line;
	const turn = (options.rotation * Math.PI) / 180;
	ctx.lineWidth = 2;

	if (options.pattern === "metatron") {
		// Thirteen equal circles: the centre, a touching inner ring, and an outer ring twice as far.
		const r = size * 0.19;
		const centers: Point[] = [[c, c]];
		for (const distance of [r, r * 2]) {
			for (let i = 0; i < 6; i++)
				centers.push(polar(c, c, distance, (2 * Math.PI * i) / 6 + turn));
		}
		centers.slice(0, options.layers >= 2 ? 13 : 7).forEach(([x, y], i) => {
			ctx.strokeStyle = color(i);
			circle(ctx, x, y, r / 2);
		});
		const links: [number, number][] = [];
		for (let i = 1; i <= 6; i++) links.push([0, i], [i, (i % 6) + 1]);
		if (options.layers >= 2) {
			for (let i = 1; i <= 6; i++) links.push([i, i + 6], [i + 6, (i % 6) + 7]);
		}
		ctx.strokeStyle = colors[0] ?? s.line;
		ctx.lineWidth = 1;
		for (const [a, b] of links) {
			const from = centers[a];
			const to = centers[b];
			if (from && to) path(ctx, [from, to]);
		}
	} else if (options.pattern === "sri_yantra") {
		const base = size / 3;
		for (let layer = 0; layer < options.layers; layer++) {
			const t = base - (layer * base) / (options.layers + 1);
			if (t <= 10) break;
			ctx.strokeStyle = color(layer);
			const up: Point[] = [
				[c, c - t],
				[c - t * 0.866, c + t * 0.5],
				[c + t * 0.866, c + t * 0.5],
			];
			const down: Point[] = [
				[c, c + t],
				[c - t * 0.866, c - t * 0.5],
				[c + t * 0.866, c - t * 0.5],
			];
			path(ctx, rotate(up, c, options.rotation), true);
			path(ctx, rotate(down, c, options.rotation), true);
		}
		ctx.strokeStyle = colors[0] ?? s.line;
		circle(ctx, c, c, base + 20);
	} else if (options.pattern === "vesica_pisces") {
		const base = size / 4;
		for (let layer = 0; layer < options.layers; layer++) {
			const r = base + (layer * base) / 3;
			if (r >= size / 2) break;
			const dx = r * 0.5 * Math.cos(turn);
			const dy = r * 0.5 * Math.sin(turn);
			ctx.strokeStyle = color(layer);
			circle(ctx, c - dx, c - dy, r);
			circle(ctx, c + dx, c + dy, r);
		}
	} else {
		// Flower of life: rings of six-fold packed circles around a centre circle.
		const r = size / 6;
		ctx.strokeStyle = colors[0] ?? s.line;
		circle(ctx, c, c, r);
		for (let layer = 1; layer <= options.layers; layer++) {
			const count = 6 * layer;
			ctx.strokeStyle = color(layer);
			for (let i = 0; i < count; i++) {
				const [x, y] = polar(
					c,
					c,
					layer * r * 1.1,
					(2 * Math.PI * i) / count + turn,
				);
				if (x - r < 0 || x + r > size || y - r < 0 || y + r > size) continue;
				circle(ctx, x, y, r);
			}
		}
	}
	return s.png();
}
