/**
 * Shared canvas helpers of the magic drawings: a surface in the bundled palette, circles, paths,
 * and polar points.
 */
import { type CanvasRenderingContext2D, createCanvas } from "canvas";
import { ensureFont, PALETTE } from "./style.ts";

export type Background = "dark" | "white" | "transparent";
export type Point = readonly [number, number];

export interface Surface {
	ctx: CanvasRenderingContext2D;
	size: number;
	line: string;
	png: () => Uint8Array;
}

export function surface(size: number, background: Background): Surface {
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

export function circle(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	r: number,
): void {
	ctx.beginPath();
	ctx.arc(x, y, r, 0, Math.PI * 2);
	ctx.stroke();
}

export function path(
	ctx: CanvasRenderingContext2D,
	points: readonly Point[],
	close = false,
): void {
	const [first, ...rest] = points;
	if (!first) return;
	if (rest.length === 0) {
		// A path of one point, such as an intention of one letter, would draw nothing; mark the point.
		ctx.beginPath();
		ctx.arc(first[0], first[1], Math.max(4, ctx.lineWidth * 2), 0, Math.PI * 2);
		ctx.fillStyle = ctx.strokeStyle;
		ctx.fill();
		return;
	}
	ctx.beginPath();
	ctx.moveTo(first[0], first[1]);
	for (const [x, y] of rest) ctx.lineTo(x, y);
	if (close) ctx.closePath();
	ctx.stroke();
}

/** Whether canvas accepts the text as a color: it leaves its fill alone for what it cannot parse. */
export function isCssColor(value: string): boolean {
	const ctx = createCanvas(1, 1).getContext("2d");
	return ["#010203", "#040506"].some((sentinel) => {
		ctx.fillStyle = sentinel;
		ctx.fillStyle = value;
		return ctx.fillStyle !== sentinel;
	});
}

export function polar(cx: number, cy: number, r: number, angle: number): Point {
	return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
}

// --- Magic circles ---
