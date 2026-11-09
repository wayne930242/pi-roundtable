import type { Hall } from "./hall";
/**
 * The hall's pictures, drawn once on canvases when the scene starts: flat fills, a few tones and a
 * dark outline, the way the characters are drawn. Nothing is fetched and nothing is a photograph.
 */

export function canvas(
	w: number,
	h: number,
): [HTMLCanvasElement, CanvasRenderingContext2D] {
	const c = document.createElement("canvas");
	c.width = w;
	c.height = h;
	const g = c.getContext("2d");
	if (!g) throw new Error("a canvas has no 2D context");
	return [c, g];
}

export const rng = (seed: number) => {
	let state = seed;
	return () => {
		state += 0x6d2b79f5;
		let t = Math.imul(state ^ (state >>> 15), state | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

/** One of three glass tones, the lighter and darker ones less often than the middle one. */
export const pane = (hall: Hall, pick: number): string =>
	pick > 0.7 ? hall.glassLight : pick < 0.3 ? hall.glassDark : hall.glass;

export type G = CanvasRenderingContext2D;

export const outline = (g: G, color: string, width: number) => {
	g.strokeStyle = color;
	g.lineWidth = width;
	g.lineJoin = "round";
	g.lineCap = "round";
	g.stroke();
};

/** A pointed arch (a lancet window's top) closed down to the sill. */
export function lancet(g: G, x: number, y: number, w: number, h: number): void {
	const spring = y + w * 0.9;
	g.beginPath();
	g.moveTo(x, y + h);
	g.lineTo(x, spring);
	g.bezierCurveTo(x, y + w * 0.35, x + w * 0.38, y + w * 0.12, x + w / 2, y);
	g.bezierCurveTo(
		x + w * 0.62,
		y + w * 0.12,
		x + w,
		y + w * 0.35,
		x + w,
		spring,
	);
	g.lineTo(x + w, y + h);
	g.closePath();
}

/** A four-pointed star. */
export function star(
	g: G,
	x: number,
	y: number,
	r: number,
	pinch = 0.32,
): void {
	g.beginPath();
	for (let i = 0; i < 8; i += 1) {
		const a = (Math.PI / 4) * i - Math.PI / 2;
		const d = i % 2 === 0 ? r : r * pinch;
		g.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d);
	}
	g.closePath();
}
