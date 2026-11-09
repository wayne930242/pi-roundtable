import {
	type Background,
	circle,
	isCssColor,
	type Point,
	path,
	polar,
	surface,
} from "./draw-kit.ts";
import { DrawingError } from "./errors.ts";

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
	/** Ignore a color canvas cannot parse, as it would, instead of refusing it. */
	permissive?: boolean;
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
		if (!options.permissive && !isCssColor(color))
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

	// Every figure is scaled to fit inside the frame with a margin, so each layer shows.
	const reach = c - 20;

	if (options.pattern === "metatron") {
		// Thirteen equal circles: the centre, a touching inner ring, and an outer ring twice as far,
		// with a line between every pair of centres. One layer is the inner seven circles; two or more, all thirteen.
		const r = reach / 2.5;
		const centers: Point[] = [[c, c]];
		for (const distance of [r, r * 2]) {
			for (let i = 0; i < 6; i++)
				centers.push(polar(c, c, distance, (2 * Math.PI * i) / 6 + turn));
		}
		const shown = centers.slice(0, options.layers >= 2 ? 13 : 7);
		shown.forEach(([x, y], i) => {
			ctx.strokeStyle = color(i);
			circle(ctx, x, y, r / 2);
		});
		ctx.strokeStyle = colors[0] ?? s.line;
		ctx.lineWidth = 1;
		for (const [i, from] of shown.entries())
			for (const to of shown.slice(i + 1)) path(ctx, [from, to]);
	} else if (options.pattern === "sri_yantra") {
		// A simplified yantra: upward and downward triangles in nested pairs around a point, inside a circle.
		const base = size / 3;
		for (let layer = 0; layer < options.layers; layer++) {
			const t = base - (layer * base) / (options.layers + 1);
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
		path(ctx, [[c, c]]);
	} else if (options.pattern === "vesica_pisces") {
		// Pairs of overlapping circles, each centred half a radius from the middle; the largest pair fills the frame.
		const outer = reach / 1.5;
		for (let layer = 0; layer < options.layers; layer++) {
			const r = (outer * (layer + 1)) / options.layers;
			const dx = r * 0.5 * Math.cos(turn);
			const dy = r * 0.5 * Math.sin(turn);
			ctx.strokeStyle = color(layer);
			circle(ctx, c - dx, c - dy, r);
			circle(ctx, c + dx, c + dy, r);
		}
	} else {
		// Flower of life: circles of one radius on a six-fold lattice whose spacing is that radius, ring after ring around the centre.
		const r = reach / (options.layers + 1);
		ctx.strokeStyle = colors[0] ?? s.line;
		circle(ctx, c, c, r);
		for (let ring = 1; ring <= options.layers; ring++) {
			ctx.strokeStyle = color(ring);
			const corners = Array.from({ length: 6 }, (_, j) =>
				polar(c, c, ring * r, (Math.PI * j) / 3 + turn),
			);
			corners.forEach((from, j) => {
				const to = corners[(j + 1) % 6] ?? from;
				for (let step = 0; step < ring; step++)
					circle(
						ctx,
						from[0] + ((to[0] - from[0]) * step) / ring,
						from[1] + ((to[1] - from[1]) * step) / ring,
						r,
					);
			});
		}
	}
	return s.png();
}
