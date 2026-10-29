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

const rng = (seed: number) => {
	let state = seed;
	return () => {
		state += 0x6d2b79f5;
		let t = Math.imul(state ^ (state >>> 15), state | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

/** One of three glass tones, the lighter and darker ones less often than the middle one. */
const pane = (hall: Hall, pick: number): string =>
	pick > 0.7 ? hall.glassLight : pick < 0.3 ? hall.glassDark : hall.glass;

type G = CanvasRenderingContext2D;

const outline = (g: G, color: string, width: number) => {
	g.strokeStyle = color;
	g.lineWidth = width;
	g.lineJoin = "round";
	g.lineCap = "round";
	g.stroke();
};

/** A pointed arch (a lancet window's top) closed down to the sill. */
function lancet(g: G, x: number, y: number, w: number, h: number): void {
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
function star(g: G, x: number, y: number, r: number, pinch = 0.32): void {
	g.beginPath();
	for (let i = 0; i < 8; i += 1) {
		const a = (Math.PI / 4) * i - Math.PI / 2;
		const d = i % 2 === 0 ? r : r * pinch;
		g.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d);
	}
	g.closePath();
}

/** The floor's flagstones: two close tones and dark joints, repeated. */
export function floorCanvas(hall: Hall): HTMLCanvasElement {
	const [c, g] = canvas(512, 512);
	const r = rng(11);
	g.fillStyle = hall.floor;
	g.fillRect(0, 0, 512, 512);
	const n = 4;
	const s = 512 / n;
	for (let row = 0; row < n; row += 1)
		for (let col = 0; col < n; col += 1) {
			if ((row + col) % 2 === 0 || r() > 0.7) {
				g.fillStyle = hall.stoneShade;
				g.globalAlpha = 0.28;
				g.fillRect(col * s, row * s, s, s);
				g.globalAlpha = 1;
			}
		}
	g.strokeStyle = hall.floorJoint;
	g.lineWidth = 6;
	for (let i = 0; i <= n; i += 1) {
		g.beginPath();
		g.moveTo(i * s, 0);
		g.lineTo(i * s, 512);
		g.moveTo(0, i * s);
		g.lineTo(512, i * s);
		g.stroke();
	}
	return c;
}

/** The wall's masonry: courses of blocks in two tones with dark joints, repeated. */
export function wallCanvas(hall: Hall): HTMLCanvasElement {
	const [c, g] = canvas(512, 512);
	const r = rng(23);
	g.fillStyle = hall.stone;
	g.fillRect(0, 0, 512, 512);
	const rows = 8;
	const h = 512 / rows;
	for (let row = 0; row < rows; row += 1) {
		const cols = row % 2 === 0 ? 4 : 5;
		const w = 512 / (row % 2 === 0 ? 4 : 4);
		const off = row % 2 === 0 ? 0 : -w / 2;
		for (let col = 0; col <= cols; col += 1) {
			const x = off + col * w;
			if (r() > 0.55) {
				g.fillStyle = hall.stoneShade;
				g.globalAlpha = 0.45;
				g.fillRect(x, row * h, w, h);
				g.globalAlpha = 1;
			}
			g.fillStyle = hall.stoneJoint;
			g.fillRect(x - 3, row * h, 6, h);
		}
		g.fillStyle = hall.stoneJoint;
		g.fillRect(0, row * h - 3, 512, 6);
	}
	return c;
}

/** The teal rune circle on the floor: rings, a star, and a belt of small signs, glowing. */
export function runeCanvas(hall: Hall): HTMLCanvasElement {
	const size = 1024;
	const [c, g] = canvas(size, size);
	const mid = size / 2;
	g.translate(mid, mid);
	g.strokeStyle = hall.rune;
	g.fillStyle = hall.rune;
	g.lineCap = "round";
	g.lineJoin = "round";
	g.shadowColor = hall.rune;
	g.shadowBlur = 26;
	const ring = (radius: number, width: number) => {
		g.lineWidth = width;
		g.beginPath();
		g.arc(0, 0, radius, 0, Math.PI * 2);
		g.stroke();
	};
	ring(480, 14);
	ring(452, 4);
	ring(330, 10);
	ring(300, 4);
	ring(150, 8);
	// the belt between the rings: eight stars and eight crescents
	for (let i = 0; i < 16; i += 1) {
		g.save();
		g.rotate((Math.PI * 2 * i) / 16);
		g.translate(0, -391);
		if (i % 2 === 0) {
			star(g, 0, 0, 34, 0.3);
			g.fill();
		} else {
			g.beginPath();
			g.arc(0, 0, 22, 0.55 * Math.PI, 2.45 * Math.PI);
			g.arc(9, -2, 18, 2.45 * Math.PI, 0.55 * Math.PI, true);
			g.closePath();
			g.fill();
		}
		g.restore();
	}
	// the big star in the middle, and spokes out to the belt
	g.lineWidth = 7;
	for (let i = 0; i < 8; i += 1) {
		g.save();
		g.rotate((Math.PI * 2 * i) / 8);
		g.beginPath();
		g.moveTo(0, -150);
		g.lineTo(0, -300);
		g.stroke();
		g.restore();
	}
	star(g, 0, 0, 142, 0.2);
	g.fill();
	g.shadowBlur = 0;
	g.fillStyle = hall.bg;
	g.globalAlpha = 0.55;
	star(g, 0, 0, 52, 0.4);
	g.fill();
	return c;
}

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

/** A soft round glow, for the speaking podium's light and the torches' halos. */
export function glowCanvas(): HTMLCanvasElement {
	const [c, g] = canvas(128, 128);
	const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
	grad.addColorStop(0, "rgba(255,255,255,1)");
	grad.addColorStop(0.35, "rgba(255,255,255,.55)");
	grad.addColorStop(1, "rgba(255,255,255,0)");
	g.fillStyle = grad;
	g.fillRect(0, 0, 128, 128);
	return c;
}

/** Light shafts: a few slanted bands in flat translucent white; the material tints them. */
export function beamCanvas(): HTMLCanvasElement {
	const [c, g] = canvas(256, 512);
	const bands: ReadonlyArray<[number, number, number]> = [
		[20, 60, 0.55],
		[96, 40, 0.8],
		[150, 70, 0.45],
		[220, 30, 0.7],
	];
	for (const [x, w, a] of bands) {
		g.fillStyle = `rgba(255,255,255,${a})`;
		g.beginPath();
		g.moveTo(x, 0);
		g.lineTo(x + w, 0);
		g.lineTo(x + w + 90, 512);
		g.lineTo(x + 90, 512);
		g.closePath();
		g.fill();
	}
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
