/** Procedural canvas textures: nothing is fetched, everything is drawn once and tinted by materials. */

const rng = (seed: number) => () => {
	seed |= 0;
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export function canvas(
	w: number,
	h: number,
): [HTMLCanvasElement, CanvasRenderingContext2D] {
	const c = document.createElement("canvas");
	c.width = w;
	c.height = h;
	return [c, c.getContext("2d")!];
}

export function woodCanvas(): HTMLCanvasElement {
	const [c, g] = canvas(512, 512);
	const r = rng(7);
	g.fillStyle = "rgb(222,222,222)";
	g.fillRect(0, 0, 512, 512);
	for (let i = 0; i < 14; i++) {
		g.fillStyle = `rgba(0,0,0,${0.015 + r() * 0.035})`;
		g.fillRect(0, r() * 512, 512, 12 + r() * 60);
	}
	for (let i = 0; i < 150; i++) {
		const y = r() * 512;
		const amp = 2 + r() * 6;
		const ph = r() * 6;
		g.strokeStyle = `rgba(40,30,20,${0.05 + r() * 0.16})`;
		g.lineWidth = 0.7 + r() * 2.2;
		g.beginPath();
		for (let x = 0; x <= 512; x += 16)
			g.lineTo(x, y + Math.sin(x * 0.02 + ph) * amp);
		g.stroke();
	}
	return c;
}

export function stoneCanvas(): HTMLCanvasElement {
	const [c, g] = canvas(512, 512);
	const r = rng(21);
	g.fillStyle = "rgb(90,90,90)";
	g.fillRect(0, 0, 512, 512);
	const rows = 6;
	const h = 512 / rows;
	for (let row = 0; row < rows; row++) {
		const cuts = [0];
		for (let i = 0; i < 4; i++)
			cuts.push(((i + 1) / 5) * 512 + (r() - 0.5) * 50);
		cuts.push(512);
		cuts.sort((a, b) => a - b);
		for (let i = 0; i < cuts.length - 1; i++) {
			const lum = 168 + r() * 52;
			g.fillStyle = `rgb(${lum},${lum},${lum})`;
			g.beginPath();
			g.roundRect(
				cuts[i]! + 3,
				row * h + 3,
				cuts[i + 1]! - cuts[i]! - 6,
				h - 6,
				8,
			);
			g.fill();
			g.fillStyle = `rgba(255,255,255,${0.05 + r() * 0.07})`;
			g.fillRect(cuts[i]! + 6, row * h + 6, cuts[i + 1]! - cuts[i]! - 12, 5);
		}
	}
	for (let i = 0; i < 2600; i++) {
		g.fillStyle = `rgba(0,0,0,${r() * 0.09})`;
		g.fillRect(r() * 512, r() * 512, 1 + r() * 3, 1 + r() * 3);
	}
	return c;
}

export function plainCanvas(): HTMLCanvasElement {
	const [c, g] = canvas(256, 256);
	const r = rng(3);
	g.fillStyle = "rgb(236,236,236)";
	g.fillRect(0, 0, 256, 256);
	for (let i = 0; i < 1400; i++) {
		g.fillStyle = `rgba(0,0,0,${r() * 0.035})`;
		g.fillRect(r() * 256, r() * 256, 2, 2);
	}
	return c;
}

export function glowCanvas(): HTMLCanvasElement {
	const [c, g] = canvas(128, 128);
	const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
	grad.addColorStop(0, "rgba(255,255,255,1)");
	grad.addColorStop(0.25, "rgba(255,255,255,0.62)");
	grad.addColorStop(0.55, "rgba(255,255,255,0.18)");
	grad.addColorStop(1, "rgba(255,255,255,0)");
	g.fillStyle = grad;
	g.fillRect(0, 0, 128, 128);
	return c;
}

/** a spotlight shaft: narrow at the top, wide at the foot, fading upward */
export function shaftCanvas(): HTMLCanvasElement {
	const [c, g] = canvas(128, 256);
	const grad = g.createLinearGradient(0, 0, 0, 256);
	grad.addColorStop(0, "rgba(255,255,255,0)");
	grad.addColorStop(0.55, "rgba(255,255,255,0.35)");
	grad.addColorStop(1, "rgba(255,255,255,0.8)");
	g.fillStyle = grad;
	g.beginPath();
	g.moveTo(52, 0);
	g.lineTo(76, 0);
	g.lineTo(124, 256);
	g.lineTo(4, 256);
	g.closePath();
	g.fill();
	// soften the sides
	g.globalCompositeOperation = "destination-in";
	const side = g.createLinearGradient(0, 0, 128, 0);
	side.addColorStop(0, "rgba(0,0,0,0)");
	side.addColorStop(0.3, "rgba(0,0,0,1)");
	side.addColorStop(0.7, "rgba(0,0,0,1)");
	side.addColorStop(1, "rgba(0,0,0,0)");
	g.fillStyle = side;
	g.fillRect(0, 0, 128, 256);
	return c;
}

/** 3 icons in a row: attention banner, check badge, cross badge. White shapes with dark glyphs, tinted per instance. */
export function iconsCanvas(): HTMLCanvasElement {
	const [c, g] = canvas(384, 128);
	g.lineJoin = "round";
	g.lineCap = "round";
	// heraldic banner on a pole
	g.fillStyle = "#fff";
	g.strokeStyle = "#2b2118";
	g.lineWidth = 6;
	g.beginPath();
	g.moveTo(34, 12);
	g.lineTo(94, 12);
	g.quadraticCurveTo(98, 70, 64, 108);
	g.quadraticCurveTo(30, 70, 34, 12);
	g.closePath();
	g.fill();
	g.stroke();
	g.fillStyle = "#2b2118";
	g.font = "800 62px system-ui, sans-serif";
	g.textAlign = "center";
	g.textBaseline = "middle";
	g.fillText("!", 64, 54);
	// check badge
	g.fillStyle = "#fff";
	g.strokeStyle = "#1d2a22";
	g.beginPath();
	g.arc(192, 64, 46, 0, Math.PI * 2);
	g.fill();
	g.stroke();
	g.lineWidth = 12;
	g.beginPath();
	g.moveTo(168, 66);
	g.lineTo(186, 84);
	g.lineTo(218, 46);
	g.stroke();
	// cross badge
	g.fillStyle = "#fff";
	g.strokeStyle = "#2a1414";
	g.lineWidth = 6;
	g.beginPath();
	g.arc(320, 64, 46, 0, Math.PI * 2);
	g.fill();
	g.stroke();
	g.lineWidth = 12;
	g.beginPath();
	g.moveTo(302, 46);
	g.lineTo(338, 82);
	g.moveTo(338, 46);
	g.lineTo(302, 82);
	g.stroke();
	return c;
}

export function runeCanvas(): HTMLCanvasElement {
	const [c, g] = canvas(512, 512);
	g.strokeStyle = "#fff";
	g.fillStyle = "#fff";
	g.lineCap = "round";
	g.lineJoin = "round";
	const cx = 256;
	const ring = (r: number, w: number) => {
		g.lineWidth = w;
		g.beginPath();
		g.arc(cx, cx, r, 0, Math.PI * 2);
		g.stroke();
	};
	ring(246, 8);
	ring(222, 3);
	ring(150, 3);
	for (let i = 0; i < 12; i++) {
		const a = (i / 12) * Math.PI * 2;
		g.lineWidth = 3;
		g.beginPath();
		g.moveTo(cx + Math.cos(a) * 150, cx + Math.sin(a) * 150);
		g.lineTo(cx + Math.cos(a) * 222, cx + Math.sin(a) * 222);
		g.stroke();
		g.beginPath();
		g.arc(
			cx + Math.cos(a + Math.PI / 12) * 186,
			cx + Math.sin(a + Math.PI / 12) * 186,
			7,
			0,
			Math.PI * 2,
		);
		g.fill();
	}
	g.lineWidth = 4;
	g.beginPath();
	for (let i = 0; i < 16; i++) {
		const a = (i / 16) * Math.PI * 2 - Math.PI / 2;
		const r = i % 2 ? 46 : 120;
		g.lineTo(cx + Math.cos(a) * r, cx + Math.sin(a) * r);
	}
	g.closePath();
	g.stroke();
	g.beginPath();
	g.arc(cx, cx, 18, 0, Math.PI * 2);
	g.fill();
	return c;
}

export function ringCanvas(): HTMLCanvasElement {
	const [c, g] = canvas(512, 512);
	g.strokeStyle = "#fff";
	g.fillStyle = "#fff";
	g.lineWidth = 5;
	g.beginPath();
	g.arc(256, 256, 246, 0, Math.PI * 2);
	g.stroke();
	g.lineWidth = 2;
	g.beginPath();
	g.arc(256, 256, 214, 0, Math.PI * 2);
	g.stroke();
	g.globalAlpha = 0.55;
	g.beginPath();
	g.arc(256, 256, 40, 0, Math.PI * 2);
	g.fill();
	return c;
}
