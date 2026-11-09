import { canvas, lancet, outline, pane, rng, star } from "./decals-base";
import type { Hall } from "./hall";

/** A lancet window with its mullions, or the round window with the moon (the sun by day). */
export function windowCanvas(
	hall: Hall,
	kind: "lancet" | "rose",
): HTMLCanvasElement {
	const r = rng(kind === "rose" ? 5 : 9);
	if (kind === "lancet") {
		const [c, g] = canvas(256, 512);
		lancet(g, 14, 10, 228, 492);
		g.save();
		g.clip();
		g.fillStyle = hall.glass;
		g.fillRect(0, 0, 256, 512);
		const cols = 3;
		const rows = 8;
		const w = 228 / cols;
		const h = 492 / rows;
		for (let row = 0; row < rows; row += 1)
			for (let col = 0; col < cols; col += 1) {
				g.fillStyle = pane(hall, r());
				g.fillRect(14 + col * w, 10 + row * h, w, h);
			}
		if (hall.night) {
			g.fillStyle = hall.sky;
			for (let i = 0; i < 6; i += 1) {
				star(g, 40 + r() * 176, 60 + r() * 380, 5 + r() * 4, 0.3);
				g.fill();
			}
		}
		g.restore();
		g.strokeStyle = hall.stoneJoint;
		g.lineWidth = 9;
		for (let col = 1; col < cols; col += 1) {
			g.beginPath();
			g.moveTo(14 + col * w, 10);
			g.lineTo(14 + col * w, 502);
			g.stroke();
		}
		for (let row = 1; row < rows; row += 1) {
			g.beginPath();
			g.moveTo(14, 10 + row * h);
			g.lineTo(242, 10 + row * h);
			g.stroke();
		}
		lancet(g, 14, 10, 228, 492);
		outline(g, hall.ink, 12);
		return c;
	}
	const size = 512;
	const [c, g] = canvas(size, size);
	const mid = size / 2;
	g.beginPath();
	g.arc(mid, mid, 236, 0, Math.PI * 2);
	g.save();
	g.clip();
	g.fillStyle = hall.glass;
	g.fillRect(0, 0, size, size);
	const cell = size / 8;
	for (let row = 0; row < 8; row += 1)
		for (let col = 0; col < 8; col += 1) {
			g.fillStyle = pane(hall, r());
			g.fillRect(col * cell, row * cell, cell, cell);
		}
	// the moon (or the sun) and a few stars
	g.fillStyle = hall.sky;
	g.beginPath();
	g.arc(mid, mid - 8, 98, 0, Math.PI * 2);
	g.fill();
	if (hall.night) {
		g.fillStyle = hall.glass;
		g.beginPath();
		g.arc(mid + 52, mid - 34, 88, 0, Math.PI * 2);
		g.fill();
		g.fillStyle = hall.sky;
		for (const [x, y, s] of [
			[150, 120, 12],
			[380, 150, 9],
			[120, 340, 8],
			[400, 360, 12],
			[310, 90, 7],
		] as const) {
			star(g, x, y, s, 0.3);
			g.fill();
		}
	} else {
		g.strokeStyle = hall.sky;
		g.lineWidth = 12;
		for (let i = 0; i < 12; i += 1) {
			const a = (Math.PI * 2 * i) / 12;
			g.beginPath();
			g.moveTo(mid + Math.cos(a) * 120, mid - 8 + Math.sin(a) * 120);
			g.lineTo(mid + Math.cos(a) * 190, mid - 8 + Math.sin(a) * 190);
			g.stroke();
		}
	}
	g.restore();
	g.strokeStyle = hall.stoneJoint;
	g.lineWidth = 12;
	for (let i = 1; i < 8; i += 1) {
		g.beginPath();
		g.moveTo(i * cell, 0);
		g.lineTo(i * cell, size);
		g.moveTo(0, i * cell);
		g.lineTo(size, i * cell);
		g.stroke();
	}
	g.beginPath();
	g.arc(mid, mid, 236, 0, Math.PI * 2);
	outline(g, hall.ink, 16);
	g.beginPath();
	g.arc(mid, mid, 246, 0, Math.PI * 2);
	outline(g, hall.stoneShade, 14);
	return c;
}

export type Emblem = "moon" | "star" | "crest";

/** A hanging banner with a swallow tail, a gold edge and one emblem. */
export function bannerCanvas(hall: Hall, emblem: Emblem): HTMLCanvasElement {
	const [c, g] = canvas(256, 512);
	const body = () => {
		g.beginPath();
		g.moveTo(24, 10);
		g.lineTo(232, 10);
		g.lineTo(232, 470);
		g.lineTo(128, 400);
		g.lineTo(24, 470);
		g.closePath();
	};
	body();
	g.fillStyle = hall.banner;
	g.fill();
	g.save();
	body();
	g.clip();
	g.fillStyle = hall.ink;
	g.globalAlpha = 0.18;
	g.fillRect(128, 0, 128, 512);
	g.restore();
	body();
	outline(g, hall.bannerEdge, 14);
	body();
	outline(g, hall.ink, 5);
	g.strokeStyle = hall.bannerEdge;
	g.fillStyle = hall.bannerEdge;
	g.lineWidth = 9;
	g.lineCap = "round";
	g.beginPath();
	g.moveTo(40, 56);
	g.lineTo(216, 56);
	g.stroke();
	if (emblem === "star") {
		star(g, 128, 220, 84, 0.22);
		g.fill();
		g.beginPath();
		g.arc(128, 220, 14, 0, Math.PI * 2);
		g.fillStyle = hall.banner;
		g.fill();
	} else if (emblem === "moon") {
		g.beginPath();
		g.arc(128, 215, 74, 0, Math.PI * 2);
		g.fill();
		g.fillStyle = hall.banner;
		g.beginPath();
		g.arc(158, 196, 66, 0, Math.PI * 2);
		g.fill();
		g.fillStyle = hall.bannerEdge;
		star(g, 170, 266, 24, 0.3);
		g.fill();
	} else {
		g.beginPath();
		g.moveTo(128, 120);
		g.lineTo(190, 215);
		g.lineTo(128, 320);
		g.lineTo(66, 215);
		g.closePath();
		g.lineWidth = 11;
		g.stroke();
		star(g, 128, 215, 34, 0.3);
		g.fill();
	}
	return c;
}

/** A podium's front panel: a raised panel in a second, lighter wood with a gold frame and the diamond star. */
export function panelCanvas(hall: Hall): HTMLCanvasElement {
	const [c, g] = canvas(256, 320);
	g.fillStyle = hall.woodDark;
	g.fillRect(8, 8, 240, 304);
	g.fillStyle = hall.woodLight;
	g.fillRect(24, 24, 208, 272);
	// the bevel: light on the upper edges, shade on the lower
	g.fillStyle = hall.wood;
	g.beginPath();
	g.moveTo(24, 296);
	g.lineTo(232, 296);
	g.lineTo(232, 24);
	g.lineTo(212, 44);
	g.lineTo(212, 276);
	g.lineTo(44, 276);
	g.closePath();
	g.fill();
	g.fillStyle = hall.woodDark;
	g.fillRect(44, 44, 168, 232);
	g.strokeStyle = hall.goldDark;
	g.lineWidth = 8;
	g.strokeRect(44, 44, 168, 232);
	g.strokeStyle = hall.gold;
	g.lineWidth = 4;
	g.strokeRect(56, 56, 144, 208);
	g.fillStyle = hall.gold;
	g.beginPath();
	g.moveTo(128, 84);
	g.lineTo(172, 160);
	g.lineTo(128, 238);
	g.lineTo(84, 160);
	g.closePath();
	g.fill();
	g.fillStyle = hall.woodDark;
	g.beginPath();
	g.moveTo(128, 122);
	g.lineTo(148, 160);
	g.lineTo(128, 202);
	g.lineTo(108, 160);
	g.closePath();
	g.fill();
	g.strokeStyle = hall.ink;
	g.lineWidth = 5;
	g.strokeRect(8, 8, 240, 304);
	return c;
}
