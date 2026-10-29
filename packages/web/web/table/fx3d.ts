import {
	AdditiveBlending,
	CanvasTexture,
	DoubleSide,
	Group,
	Mesh,
	MeshBasicMaterial,
	NormalBlending,
	PlaneGeometry,
	Sprite,
	SpriteMaterial,
	SRGBColorSpace,
} from "three";
import { canvas, runeCanvas } from "./decals";
import type { Hall } from "./hall";
import { backOut, PUFF_MS, RISE_MS, risePose } from "./seating";
import { mixHex } from "./standee";

/**
 * The little shows of the table in the hall's one style: the smoke that takes a leaving seat and the
 * rune circle a joining seat rises out of. Every picture is drawn here on a small canvas (flat fills,
 * two tones, a dark outline), the shapes are a few sprites and planes, and `dispose` gives all of
 * it back as soon as the last show has ended.
 */

const TAU = Math.PI * 2;
const clamp = (value: number, low = 0, high = 1) =>
	Math.min(high, Math.max(low, value));

/** A cartoon cloud: a union of circles with one outline round it, lit from the upper left. */
export function cloudCanvas(hall: Hall): HTMLCanvasElement {
	const [c, g] = canvas(128, 128);
	const lobes: ReadonlyArray<readonly [number, number, number]> = [
		[64, 74, 30],
		[36, 80, 22],
		[92, 80, 23],
		[48, 54, 24],
		[80, 56, 22],
	];
	const base = hall.paper;
	const shade = mixHex(hall.paper, hall.ink, hall.night ? 0.42 : 0.28);
	g.fillStyle = hall.ink;
	for (const [x, y, r] of lobes) {
		g.beginPath();
		g.arc(x, y, r + 5, 0, TAU);
		g.fill();
	}
	g.save();
	g.beginPath();
	for (const [x, y, r] of lobes) {
		g.moveTo(x + r, y);
		g.arc(x, y, r, 0, TAU);
	}
	g.clip();
	g.fillStyle = shade;
	g.fillRect(0, 0, 128, 128);
	g.fillStyle = base;
	for (const [x, y, r] of lobes) {
		g.beginPath();
		g.arc(x - 7, y - 8, r, 0, TAU);
		g.fill();
	}
	g.restore();
	return c;
}

/** A four-pointed sparkle with a dark outline. */
export function sparkleCanvas(hall: Hall): HTMLCanvasElement {
	const [c, g] = canvas(64, 64);
	g.translate(32, 32);
	g.beginPath();
	for (let i = 0; i < 8; i += 1) {
		const a = (Math.PI / 4) * i - Math.PI / 2;
		const d = i % 2 === 0 ? 27 : 8;
		g.lineTo(Math.cos(a) * d, Math.sin(a) * d);
	}
	g.closePath();
	g.lineJoin = "round";
	g.lineWidth = 7;
	g.strokeStyle = hall.ink;
	g.stroke();
	g.fillStyle = hall.gold;
	g.fill();
	return c;
}

/** A shaft of light: bright at its foot, soft at the sides, gone at the top. */
export function columnCanvas(): HTMLCanvasElement {
	const [c, g] = canvas(64, 256);
	const across = g.createLinearGradient(0, 0, 64, 0);
	across.addColorStop(0, "rgba(255,255,255,0)");
	across.addColorStop(0.5, "rgba(255,255,255,1)");
	across.addColorStop(1, "rgba(255,255,255,0)");
	g.fillStyle = across;
	g.fillRect(0, 0, 64, 256);
	g.globalCompositeOperation = "destination-in";
	const up = g.createLinearGradient(0, 256, 0, 0);
	up.addColorStop(0, "rgba(255,255,255,1)");
	up.addColorStop(0.55, "rgba(255,255,255,.45)");
	up.addColorStop(1, "rgba(255,255,255,0)");
	g.fillStyle = up;
	g.fillRect(0, 0, 64, 256);
	return c;
}

interface Place {
	x: number;
	y: number;
	z: number;
}

/** One show: `update` is told the ms since its own start and returns false when it has ended. */
interface Run {
	start: number;
	update(ms: number): boolean;
	end(): void;
}

export class Effects {
	readonly group = new Group();
	private readonly runs: Run[] = [];
	private readonly textures = new Map<string, CanvasTexture>();
	private readonly planes = new Map<string, PlaneGeometry>();

	constructor(private readonly hall: Hall) {}

	/** A picture drawn the first time it is asked for, and kept until the shows are over. */
	private texture(name: string, make: () => HTMLCanvasElement): CanvasTexture {
		const kept = this.textures.get(name);
		if (kept) return kept;
		const t = new CanvasTexture(make());
		t.colorSpace = SRGBColorSpace;
		this.textures.set(name, t);
		return t;
	}

	private plane(name: string, width: number, height: number): PlaneGeometry {
		const kept = this.planes.get(name);
		if (kept) return kept;
		const made = new PlaneGeometry(width, height);
		this.planes.set(name, made);
		return made;
	}

	private get glow() {
		return this.hall.additive ? AdditiveBlending : NormalBlending;
	}

	/** Clouds round a place where a seat stood, swelling, drifting up and fading, with a few sparkles; `at` is the middle of the standee. */
	puff(at: Place, start: number): void {
		const hall = this.hall;
		const cloud = this.texture("cloud", () => cloudCanvas(hall));
		const sparkle = this.texture("sparkle", () => sparkleCanvas(hall));
		const clouds = Array.from({ length: 7 }, (_, i) => {
			const angle = (TAU * i) / 7 + (i % 2) * 0.4;
			const sprite = new Sprite(
				new SpriteMaterial({
					map: cloud,
					transparent: true,
					depthWrite: false,
					fog: false,
				}),
			);
			sprite.renderOrder = 8;
			this.group.add(sprite);
			return {
				sprite,
				angle,
				reach: 0.55 + (i % 3) * 0.22,
				size: 1.5 + ((i * 5) % 4) * 0.28,
				lift: -0.9 + (i % 4) * 0.75,
				turn: (i % 2 ? 1 : -1) * (0.25 + (i % 3) * 0.1),
			};
		});
		const sparks = Array.from({ length: 4 }, (_, i) => {
			const sprite = new Sprite(
				new SpriteMaterial({
					map: sparkle,
					transparent: true,
					depthWrite: false,
					depthTest: false,
					fog: false,
				}),
			);
			sprite.renderOrder = 9;
			this.group.add(sprite);
			return { sprite, angle: (TAU * i) / 4 + 0.7 };
		});
		this.runs.push({
			start,
			update: (ms) => {
				const p = clamp(ms / PUFF_MS);
				const pop = backOut(p / 0.35);
				const out = 1 - (1 - p) ** 2;
				const fade = 1 - clamp((p - 0.55) / 0.45);
				for (const c of clouds) {
					c.sprite.position.set(
						at.x + Math.cos(c.angle) * c.reach * (0.5 + out * 1.3),
						at.y + c.lift * (0.6 + out * 0.5) + p * 1.2,
						at.z + Math.sin(c.angle) * c.reach * (0.5 + out * 1.3),
					);
					c.sprite.scale.setScalar(Math.max(c.size * pop, 0.01));
					c.sprite.material.rotation = c.angle * 0.3 + c.turn * p;
					c.sprite.material.opacity = fade;
				}
				for (const s of sparks) {
					const reach = 0.9 + out * 1.6;
					s.sprite.position.set(
						at.x + Math.cos(s.angle) * reach,
						at.y + 0.5 + out * 1.4,
						at.z + Math.sin(s.angle) * reach,
					);
					s.sprite.scale.setScalar(0.5 * backOut(clamp((p - 0.1) / 0.3)));
					s.sprite.material.rotation = p * 2.5;
					s.sprite.material.opacity = 1 - clamp((p - 0.5) / 0.4);
				}
				return p < 1;
			},
			end: () => {
				for (const c of clouds) {
					this.group.remove(c.sprite);
					c.sprite.material.dispose();
				}
				for (const s of sparks) {
					this.group.remove(s.sprite);
					s.sprite.material.dispose();
				}
			},
		});
	}

	/** The small rune circle a seat rises out of, with the light that goes up as it comes; `at` is on the floor under the podium. */
	circle(at: Place, start: number): void {
		const hall = this.hall;
		const map = this.texture("rune", () => {
			const [small, g] = canvas(256, 256);
			g.drawImage(runeCanvas(hall), 0, 0, 256, 256);
			return small;
		});
		const shaft = this.texture("column", columnCanvas);
		const disc = this.plane("disc", 3.4, 3.4);
		const tall = this.plane("column", 2.2, 5);
		const spin = new Group();
		spin.position.set(at.x, at.y + 0.03, at.z);
		const ring = new Mesh(
			disc,
			new MeshBasicMaterial({
				map,
				transparent: true,
				depthWrite: false,
				blending: this.glow,
				opacity: 0,
				fog: false,
			}),
		);
		ring.rotation.x = -Math.PI / 2;
		ring.renderOrder = 4;
		spin.add(ring);
		const light = new Group();
		light.position.set(at.x, at.y + 0.1, at.z);
		const beamMaterial = new MeshBasicMaterial({
			map: shaft,
			color: hall.rune,
			transparent: true,
			depthWrite: false,
			blending: this.glow,
			side: DoubleSide,
			opacity: 0,
			fog: false,
		});
		for (const turn of [0, Math.PI / 2]) {
			const beam = new Mesh(tall, beamMaterial);
			beam.position.y = 2.5;
			beam.rotation.y = turn;
			beam.renderOrder = 6;
			light.add(beam);
		}
		this.group.add(spin, light);
		this.runs.push({
			start,
			update: (ms) => {
				const pose = risePose(ms);
				ring.material.opacity = pose.circle * (hall.night ? 1 : 0.9);
				spin.rotation.y = pose.spin;
				beamMaterial.opacity = pose.light * 0.75;
				light.scale.set(1, 0.4 + pose.light * 0.6, 1);
				return ms < RISE_MS;
			},
			end: () => {
				this.group.remove(spin, light);
				ring.material.dispose();
				beamMaterial.dispose();
			},
		});
	}

	/** Moves every show to `ms` of the clock they share; true while one is still running. */
	step(ms: number): boolean {
		for (let i = this.runs.length - 1; i >= 0; i -= 1) {
			const run = this.runs[i];
			if (!run) continue;
			const local = ms - run.start;
			if (local < 0) continue;
			if (!run.update(local)) {
				run.end();
				this.runs.splice(i, 1);
			}
		}
		return this.runs.length > 0;
	}

	dispose(): void {
		for (const run of this.runs) run.end();
		this.runs.length = 0;
		for (const t of this.textures.values()) t.dispose();
		for (const g of this.planes.values()) g.dispose();
		this.textures.clear();
		this.planes.clear();
		this.group.removeFromParent();
	}
}
