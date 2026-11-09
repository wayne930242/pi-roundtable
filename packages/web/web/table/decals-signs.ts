import { canvas, outline } from "./decals-base";
import type { Hall } from "./hall";

/** A flat flame: orange outside, a pale core, a dark outline. */
export function flameCanvas(hall: Hall): HTMLCanvasElement {
	const [c, g] = canvas(128, 192);
	const drop = (cx: number, top: number, bottom: number, half: number) => {
		g.beginPath();
		g.moveTo(cx, top);
		g.bezierCurveTo(
			cx + half * 0.2,
			top + (bottom - top) * 0.3,
			cx + half,
			top + (bottom - top) * 0.5,
			cx + half,
			bottom - half * 0.9,
		);
		g.arc(cx, bottom - half * 0.9, half, 0, Math.PI, false);
		g.bezierCurveTo(
			cx - half,
			top + (bottom - top) * 0.5,
			cx - half * 0.2,
			top + (bottom - top) * 0.3,
			cx,
			top,
		);
		g.closePath();
	};
	drop(64, 10, 182, 44);
	g.fillStyle = hall.flame;
	g.fill();
	outline(g, hall.ink, 7);
	drop(64, 74, 176, 24);
	g.fillStyle = hall.flameCore;
	g.fill();
	return c;
}

/** The little signs over a standee: waiting dots, a bang, a tick and a cross, a cell each (128 px). */
export function badgeCanvas(hall: Hall): HTMLCanvasElement {
	const [c, g] = canvas(512, 128);
	const disc = (index: number, fill: string) => {
		g.beginPath();
		g.arc(index * 128 + 64, 64, 54, 0, Math.PI * 2);
		g.fillStyle = fill;
		g.fill();
		outline(g, hall.ink, 8);
	};
	disc(0, hall.paper);
	g.fillStyle = hall.ink;
	for (const dx of [-26, 0, 26]) {
		g.beginPath();
		g.arc(64 + dx, 70, 9, 0, Math.PI * 2);
		g.fill();
	}
	disc(1, hall.gold);
	g.fillStyle = hall.ink;
	g.beginPath();
	g.moveTo(128 + 52, 26);
	g.lineTo(128 + 76, 26);
	g.lineTo(128 + 71, 74);
	g.lineTo(128 + 57, 74);
	g.closePath();
	g.fill();
	g.beginPath();
	g.arc(128 + 64, 94, 8, 0, Math.PI * 2);
	g.fill();
	disc(2, "#58c878");
	g.strokeStyle = hall.paper;
	g.lineWidth = 14;
	g.lineCap = "round";
	g.lineJoin = "round";
	g.beginPath();
	g.moveTo(256 + 38, 66);
	g.lineTo(256 + 56, 84);
	g.lineTo(256 + 92, 44);
	g.stroke();
	disc(3, "#ee4b4b");
	g.strokeStyle = hall.paper;
	g.beginPath();
	g.moveTo(384 + 44, 44);
	g.lineTo(384 + 84, 84);
	g.moveTo(384 + 84, 44);
	g.lineTo(384 + 44, 84);
	g.stroke();
	return c;
}

/** The three short strokes that radiate beside a speaker's head, as in the concept art: gold with a dark edge. */
export function marksCanvas(hall: Hall): HTMLCanvasElement {
	const [c, g] = canvas(256, 256);
	g.lineCap = "round";
	const strokes = [
		[Math.PI * 1.1, 78, 128],
		[Math.PI * 1.32, 84, 138],
		[Math.PI * 1.54, 76, 124],
	] as const;
	const ox = 196;
	const oy = 204;
	for (const [color, width] of [
		[hall.ink, 34],
		[hall.gold, 20],
	] as const) {
		g.strokeStyle = color;
		g.lineWidth = width;
		for (const [angle, from, to] of strokes) {
			g.beginPath();
			g.moveTo(ox + Math.cos(angle) * from, oy + Math.sin(angle) * from);
			g.lineTo(ox + Math.cos(angle) * to, oy + Math.sin(angle) * to);
			g.stroke();
		}
	}
	return c;
}
