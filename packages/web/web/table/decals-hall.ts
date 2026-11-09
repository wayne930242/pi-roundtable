import { canvas, rng, star } from "./decals-base";
import type { Hall } from "./hall";

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
