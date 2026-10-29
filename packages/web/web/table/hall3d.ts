import {
	AdditiveBlending,
	BackSide,
	type BufferGeometry,
	CanvasTexture,
	CircleGeometry,
	ClampToEdgeWrapping,
	CylinderGeometry,
	DoubleSide,
	Group,
	type Material,
	Mesh,
	MeshBasicMaterial,
	MeshToonMaterial,
	NormalBlending,
	PlaneGeometry,
	RepeatWrapping,
	SRGBColorSpace,
	type Texture,
} from "three";
import { ringRadius, TAU } from "./camera";
import {
	bannerCanvas,
	beamCanvas,
	type Emblem,
	flameCanvas,
	floorCanvas,
	glowCanvas,
	runeCanvas,
	wallCanvas,
	windowCanvas,
} from "./decals";
import type { Hall } from "./hall";
import { outlined, type Toon } from "./toon";

/** The stone hall round the ring: floor, dais, rune circle, wall, pillars, windows with their light, banners and torches. */

export const WALL_HEIGHT = 12;
const BAYS = 12;
const EMBLEMS: Emblem[] = ["moon", "star", "crest"];

export interface Flame {
	body: Mesh;
	halo: Mesh;
	phase: number;
	base: number;
}

export interface Built {
	group: Group;
	flames: Flame[];
	/** The light shafts; they dim and brighten very slowly. */
	beams: Mesh[];
	wallRadius: number;
	dispose(): void;
}

/** Everything a build makes that has to be released with it. */
class Owned {
	readonly textures: Texture[] = [];
	readonly geometries: BufferGeometry[] = [];
	readonly materials: Material[] = [];
	texture(canvas: HTMLCanvasElement, repeat?: [number, number]): CanvasTexture {
		const t = new CanvasTexture(canvas);
		t.colorSpace = SRGBColorSpace;
		if (repeat) {
			t.wrapS = RepeatWrapping;
			t.wrapT = RepeatWrapping;
			t.repeat.set(repeat[0], repeat[1]);
		} else {
			t.wrapS = ClampToEdgeWrapping;
			t.wrapT = ClampToEdgeWrapping;
		}
		t.anisotropy = 4;
		this.textures.push(t);
		return t;
	}
	geometry<T extends BufferGeometry>(g: T): T {
		this.geometries.push(g);
		return g;
	}
	material<T extends Material>(m: T): T {
		this.materials.push(m);
		return m;
	}
	dispose(): void {
		for (const t of this.textures) t.dispose();
		for (const g of this.geometries) g.dispose();
		for (const m of this.materials) m.dispose();
	}
}

export function buildHall(hall: Hall, count: number, toon: Toon): Built {
	const own = new Owned();
	const group = new Group();
	const hulls = new Map<BufferGeometry, BufferGeometry>();
	const ring = ringRadius(count);
	const wall = ring + 9.5;
	const decal = (
		map: Texture,
		extra: Partial<ConstructorParameters<typeof MeshBasicMaterial>[0]> = {},
	) =>
		own.material(
			new MeshBasicMaterial({
				map,
				transparent: true,
				depthWrite: false,
				fog: false,
				...extra,
			}),
		);
	const glowBlend = hall.additive ? AdditiveBlending : NormalBlending;

	// floor: flagstones out to the wall, a dais under the ring, the rune circle on it
	const floorTex = own.texture(floorCanvas(hall), [wall / 2.2, wall / 2.2]);
	const floor = new Mesh(
		own.geometry(new CircleGeometry(wall + 1, 72)),
		own.material(
			new MeshToonMaterial({
				color: "#ffffff",
				map: floorTex,
				gradientMap: toon.steps,
			}),
		),
	);
	floor.rotation.x = -Math.PI / 2;
	group.add(floor);

	const dais = new Mesh(
		own.geometry(new CylinderGeometry(ring + 1.9, ring + 2.15, 0.2, 72)),
		toon.toon("dais", hall.stoneShade),
	);
	dais.position.y = 0.1;
	outlined(dais, toon, 0.07, hulls);
	group.add(dais);

	const rune = new Mesh(
		own.geometry(new PlaneGeometry((ring - 0.7) * 2, (ring - 0.7) * 2)),
		decal(own.texture(runeCanvas(hall)), {
			blending: glowBlend,
			opacity: hall.night ? hall.runeGlow : 1,
		}),
	);
	rune.rotation.x = -Math.PI / 2;
	rune.position.y = 0.215;
	group.add(rune);

	// the wall
	const wallMat = own.material(
		new MeshToonMaterial({
			color: "#ffffff",
			map: own.texture(wallCanvas(hall), [(wall * TAU) / 7, WALL_HEIGHT / 5]),
			gradientMap: toon.steps,
			side: BackSide,
		}),
	);
	const wallMesh = new Mesh(
		own.geometry(new CylinderGeometry(wall, wall, WALL_HEIGHT, 72, 1, true)),
		wallMat,
	);
	wallMesh.position.y = WALL_HEIGHT / 2;
	group.add(wallMesh);

	// a dark band of ceiling so the wall's top edge does not show the sky
	const ceiling = new Mesh(
		own.geometry(new CircleGeometry(wall + 1, 48)),
		own.material(new MeshBasicMaterial({ color: hall.bg, side: DoubleSide })),
	);
	ceiling.rotation.x = Math.PI / 2;
	ceiling.position.y = WALL_HEIGHT;
	group.add(ceiling);

	// pillars between the bays, each with a banner and a torch
	const pillarGeo = own.geometry(
		new CylinderGeometry(0.6, 0.66, WALL_HEIGHT, 14),
	);
	const capGeo = own.geometry(new CylinderGeometry(0.88, 0.7, 0.5, 14));
	const footGeo = own.geometry(new CylinderGeometry(0.78, 0.9, 0.6, 14));
	const bannerGeo = own.geometry(new PlaneGeometry(2.2, 4.4));
	const cupGeo = own.geometry(new CylinderGeometry(0.34, 0.2, 0.36, 10));
	const armGeo = own.geometry(new CylinderGeometry(0.06, 0.06, 0.7, 6));
	const flameGeo = own.geometry(new PlaneGeometry(0.62, 0.93));
	const haloGeo = own.geometry(new PlaneGeometry(2.6, 2.6));
	const flameMat = decal(own.texture(flameCanvas(hall)), {
		transparent: true,
		alphaTest: 0.35,
		depthWrite: true,
	});
	const haloMat = decal(own.texture(glowCanvas()), {
		color: hall.flame,
		blending: glowBlend,
		opacity: hall.night ? 0.55 : 0.28,
	});
	const bannerMats = EMBLEMS.map((emblem) =>
		own.material(
			new MeshBasicMaterial({
				map: own.texture(bannerCanvas(hall, emblem)),
				transparent: true,
				alphaTest: 0.4,
				fog: false,
			}),
		),
	);
	const flames: Flame[] = [];
	const around = (az: number, radius: number, y: number, mesh: Mesh) => {
		mesh.position.set(Math.sin(az) * radius, y, Math.cos(az) * radius);
		mesh.rotation.y = az + Math.PI;
		group.add(mesh);
		return mesh;
	};
	for (let k = 0; k < BAYS; k += 1) {
		const az = (TAU * (k + 0.5)) / BAYS;
		const pillar = new Mesh(pillarGeo, toon.toon("pillar", hall.stone));
		around(az, wall - 0.7, WALL_HEIGHT / 2, pillar);
		outlined(pillar, toon, 0.06, hulls);
		const cap = new Mesh(capGeo, toon.toon("pillar", hall.stone));
		around(az, wall - 0.7, WALL_HEIGHT - 0.55, cap);
		const foot = new Mesh(footGeo, toon.toon("pillar", hall.stone));
		around(az, wall - 0.7, 0.3, foot);
		const banner = new Mesh(
			bannerGeo,
			bannerMats[k % bannerMats.length] ?? bannerMats[0],
		);
		around(az, wall - 1.34, 6.8, banner);

		// the torch: an arm, a cup and a flame with its halo, at about the height of a standing person's head
		const arm = new Mesh(armGeo, toon.toon("iron", hall.woodDark));
		around(az, wall - 1.4, 2.8, arm);
		arm.rotation.x = Math.PI / 2;
		const cup = new Mesh(cupGeo, toon.toon("iron", hall.woodDark));
		around(az, wall - 1.75, 2.95, cup);
		outlined(cup, toon, 0.04, hulls);
		const body = new Mesh(flameGeo, flameMat);
		body.position.set(
			Math.sin(az) * (wall - 1.75),
			3.5,
			Math.cos(az) * (wall - 1.75),
		);
		body.renderOrder = 3;
		group.add(body);
		const halo = new Mesh(haloGeo, haloMat);
		halo.position.copy(body.position);
		halo.renderOrder = 2;
		group.add(halo);
		flames.push({ body, halo, phase: k * 1.7, base: 1 });
	}

	// windows: a lancet in each bay, the round moon window in the bay behind the camera's far side
	const lancetGeo = own.geometry(new PlaneGeometry(2.6, 5.2));
	const roseGeo = own.geometry(new PlaneGeometry(4.6, 4.6));
	const lancetMat = decal(own.texture(windowCanvas(hall, "lancet")), {
		alphaTest: 0.3,
		depthWrite: true,
		transparent: false,
	});
	const roseMat = decal(own.texture(windowCanvas(hall, "rose")), {
		alphaTest: 0.3,
		depthWrite: true,
		transparent: false,
	});
	const beamGeo = own.geometry(new PlaneGeometry(3.4, 10));
	const beamMat = decal(own.texture(beamCanvas()), {
		color: hall.beam,
		opacity: hall.beamAlpha,
		blending: glowBlend,
		side: DoubleSide,
	});
	const beams: Mesh[] = [];
	for (let k = 0; k < BAYS; k += 1) {
		const az = (TAU * k) / BAYS;
		const far = k === BAYS / 2;
		const w = new Mesh(far ? roseGeo : lancetGeo, far ? roseMat : lancetMat);
		around(az, wall - 0.12, far ? 7.1 : 6.2, w);
		const shaft = new Mesh(beamGeo, beamMat);
		const inward = wall - 4.4;
		shaft.position.set(Math.sin(az) * inward, 4.4, Math.cos(az) * inward);
		shaft.rotation.set(0, az + Math.PI, 0);
		shaft.rotateX(-0.62);
		shaft.renderOrder = 1;
		group.add(shaft);
		beams.push(shaft);
	}

	return {
		group,
		flames,
		beams,
		wallRadius: wall,
		dispose() {
			for (const geometry of hulls.values()) geometry.dispose();
			own.dispose();
		},
	};
}

/** The flames' flicker: a size and a lean from two slow sines each, nothing at rest under reduced motion. */
export function flicker(
	flames: readonly Flame[],
	seconds: number,
	reduced: boolean,
): void {
	for (const f of flames) {
		const s = reduced
			? 1
			: 1 +
				0.09 * Math.sin(seconds * 9 + f.phase) +
				0.05 * Math.sin(seconds * 17 + f.phase * 2);
		f.body.scale.set(
			s * 0.96,
			s * (1.02 + (reduced ? 0 : 0.06 * Math.sin(seconds * 11 + f.phase))),
			1,
		);
		f.halo.scale.setScalar(
			reduced ? 1 : 0.95 + 0.1 * Math.sin(seconds * 7 + f.phase),
		);
	}
}
