import { createHash } from "node:crypto";
import {
	type Background,
	circle,
	type Point,
	path,
	polar,
	surface,
} from "./draw-kit.ts";
import { DrawingError } from "./errors.ts";

export type SigilMethod = "chaos" | "rose_cross" | "geometric" | "planetary";

export interface SigilOptions {
	intention: string;
	method: SigilMethod;
	complexity: "simple" | "elaborate";
	style: "traditional" | "modern";
	background: Background;
	/** Draw what a looser caller sends: an intention with no letters, a blank one, or an unknown color. */
	permissive?: boolean;
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
	if (options.intention.trim() === "" && !options.permissive)
		throw new DrawingError("The intention is empty. Give a short phrase.");
	if (
		options.method !== "geometric" &&
		letters(options.intention).length === 0 &&
		!options.permissive
	)
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
			for (let i = 1; i <= 7; i++) circle(ctx, c, c, (reach * i) / 7);
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
