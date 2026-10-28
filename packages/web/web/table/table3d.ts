import {
	AdditiveBlending,
	type BufferGeometry,
	CanvasTexture,
	CircleGeometry,
	ClampToEdgeWrapping,
	Color,
	CylinderGeometry,
	DirectionalLight,
	DynamicDrawUsage,
	Euler,
	Fog,
	HemisphereLight,
	InstancedBufferAttribute,
	InstancedMesh,
	LatheGeometry,
	LinearFilter,
	LinearMipmapLinearFilter,
	type Material,
	Matrix4,
	Mesh,
	MeshBasicMaterial,
	MeshLambertMaterial,
	NormalBlending,
	PerspectiveCamera,
	PlaneGeometry,
	PointLight,
	Quaternion,
	RepeatWrapping,
	Scene,
	SRGBColorSpace,
	TorusGeometry,
	Vector2,
	Vector3,
	WebGLRenderer,
} from "three";
import {
	ellipsize,
	MIN_NAME_PX,
	type PlatePlan,
	planPlates,
	plateOrder,
	rearLift,
} from "./label";
import {
	glowCanvas,
	iconsCanvas,
	canvas as makeCanvas,
	plainCanvas,
	ringCanvas,
	runeCanvas,
	shaftCanvas,
	stoneCanvas,
	woodCanvas,
} from "./textures";
import { type Palette, palette, STATE_COLOR } from "./themes";
import type {
	Scheme,
	SeatInit,
	SeatState,
	TableHandle,
	TableOptions,
	TableStats,
	ThemeName,
} from "./types";

const MAXS = 32;
const AV = 1.6; // avatar quad size
const STOOL_H = 0.1; // each seat is a low round pad (game-pawn base)
const AV_Y = 0.1; // billboard base
const ANCH = 0.1; // billboard stands slightly toward the camera so it never clips the pad
const TABLE_Y = 1.0;
const AMBIENT_MS = 12000;
const G = 7; // glow instances per seat: halo, ring, pool, flame, 3 motes
const ICON_CELLS = 3;
const LABEL_FONT = 36; // a name's font size in the plate texture when it fits whole
const LIFT_MAX = 0.42; // how far the seat across the table is raised so its head clears the table's far edge

/* ---------- instanced layer: one draw call for every seat ---------- */

function patchInstanced(mat: MeshBasicMaterial) {
	mat.customProgramCacheKey = () => "rt-instanced-rect-alpha";
	mat.onBeforeCompile = (shader) => {
		shader.vertexShader = shader.vertexShader
			.replace(
				"#include <common>",
				"#include <common>\nattribute vec4 uvRect;\nattribute float iAlpha;\nvarying float vIA;",
			)
			.replace(
				"#include <uv_vertex>",
				"#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = vMapUv * uvRect.zw + uvRect.xy;\n#endif\nvIA = iAlpha;",
			);
		shader.fragmentShader = shader.fragmentShader
			.replace("#include <common>", "#include <common>\nvarying float vIA;")
			.replace(
				"#include <opaque_fragment>",
				"#include <opaque_fragment>\ngl_FragColor.a *= vIA;",
			);
	};
}

class Layer {
	readonly mesh: InstancedMesh;
	private readonly m = new Matrix4();
	private readonly sc = new Vector3();
	private readonly rect: InstancedBufferAttribute;
	private readonly alpha: InstancedBufferAttribute;
	private rectDirty = true;
	constructor(
		geo: BufferGeometry,
		mat: MeshBasicMaterial,
		readonly cap: number,
		order: number,
	) {
		const rect = new Float32Array(cap * 4);
		for (let i = 0; i < cap; i++) rect.set([0, 0, 1, 1], i * 4);
		this.rect = new InstancedBufferAttribute(rect, 4);
		this.alpha = new InstancedBufferAttribute(new Float32Array(cap).fill(1), 1);
		this.alpha.setUsage(DynamicDrawUsage);
		geo.setAttribute("uvRect", this.rect);
		geo.setAttribute("iAlpha", this.alpha);
		patchInstanced(mat);
		this.mesh = new InstancedMesh(geo, mat, cap);
		this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
		this.mesh.setColorAt(0, new Color(1, 1, 1));
		this.mesh.instanceColor!.array.fill(1);
		this.mesh.instanceColor!.setUsage(DynamicDrawUsage);
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = order;
		this.mesh.count = 0;
	}
	put(i: number, p: Vector3, q: Quaternion, sx: number, sy = sx, sz = 1) {
		this.sc.set(sx, sy, sz);
		this.m.compose(p, q, this.sc);
		this.mesh.setMatrixAt(i, this.m);
	}
	hide(i: number) {
		this.alpha.array[i] = 0;
		this.m.makeScale(0, 0, 0);
		this.mesh.setMatrixAt(i, this.m);
	}
	col(i: number, r: number, g: number, b: number) {
		const a = this.mesh.instanceColor!.array as Float32Array;
		a[i * 3] = r;
		a[i * 3 + 1] = g;
		a[i * 3 + 2] = b;
	}
	a(i: number, v: number) {
		this.alpha.array[i] = v;
	}
	uv(i: number, u: number, v: number, w: number, h: number) {
		this.rect.array.set([u, v, w, h], i * 4);
		this.rectDirty = true;
	}
	flush() {
		this.mesh.instanceMatrix.needsUpdate = true;
		this.mesh.instanceColor!.needsUpdate = true;
		this.alpha.needsUpdate = true;
		if (this.rectDirty) {
			this.rect.needsUpdate = true;
			this.rectDirty = false;
		}
	}
}

/* ---------- atlas: every seat's avatar + name plate in one texture ---------- */

const CELL_W = 256;
const CELL_H = 320;
const COLS = 4;

class Atlas {
	canvas!: HTMLCanvasElement;
	ctx!: CanvasRenderingContext2D;
	tex!: CanvasTexture;
	rows = 0;
	resize(n: number, anisotropy: number): void {
		const rows = Math.max(1, Math.ceil(n / COLS));
		if (rows === this.rows) return;
		this.rows = rows;
		const [c, g] = makeCanvas(COLS * CELL_W, rows * CELL_H);
		this.canvas = c;
		this.ctx = g;
		this.tex?.dispose();
		this.tex = new CanvasTexture(c);
		this.tex.colorSpace = SRGBColorSpace;
		this.tex.generateMipmaps = true;
		this.tex.minFilter = LinearMipmapLinearFilter;
		this.tex.magFilter = LinearFilter;
		this.tex.anisotropy = anisotropy;
	}
	origin(i: number): [number, number] {
		return [(i % COLS) * CELL_W, Math.floor(i / COLS) * CELL_H];
	}
	/** uv rects ([u, v, w, h], v measured from the bottom because the texture is flipped) */
	avatarRect(i: number): [number, number, number, number] {
		const [x, y] = this.origin(i);
		const W = this.canvas.width;
		const H = this.canvas.height;
		return [
			(x + 1) / W,
			1 - (y + CELL_W - 1) / H,
			(CELL_W - 2) / W,
			(CELL_W - 2) / H,
		];
	}
	labelRect(i: number): [number, number, number, number] {
		const [x, y] = this.origin(i);
		const W = this.canvas.width;
		const H = this.canvas.height;
		return [
			(x + 1) / W,
			1 - (y + CELL_H - 1) / H,
			(CELL_W - 2) / W,
			(CELL_H - CELL_W - 2) / H,
		];
	}
	drawAvatar(
		i: number,
		img: CanvasImageSource | null,
		name: string,
		color: string,
	): void {
		const [x, y] = this.origin(i);
		const g = this.ctx;
		g.clearRect(x, y, CELL_W, CELL_W);
		if (img) g.drawImage(img, x, y, CELL_W, CELL_W);
		else {
			g.fillStyle = color;
			g.beginPath();
			g.arc(x + 128, y + 128, 84, 0, Math.PI * 2);
			g.fill();
			g.fillStyle = "#fff";
			g.font = "700 96px system-ui, sans-serif";
			g.textAlign = "center";
			g.textBaseline = "middle";
			g.fillText(name.slice(0, 1).toUpperCase(), x + 128, y + 134);
		}
		this.tex.needsUpdate = true;
	}
	/**
	 * The plate of seat `i`. `minSize` is the smallest the name's font may get before it is cut with an
	 * ellipsis (the size that is still `MIN_NAME_PX` on the screen); without `names` the plate is only
	 * its colour bar, for a canvas where no name could be read.
	 */
	drawLabel(
		i: number,
		name: string,
		color: string,
		p: Palette,
		names: boolean,
		minSize: number,
	): void {
		const [x, y0] = this.origin(i);
		const y = y0 + CELL_W;
		const g = this.ctx;
		g.clearRect(x, y, CELL_W, CELL_H - CELL_W);
		if (!names) {
			g.fillStyle = color;
			g.beginPath();
			g.roundRect(x + 6, y + 18, CELL_W - 12, 26, 13);
			g.fill();
			this.tex.needsUpdate = true;
			return;
		}
		g.fillStyle = p.labelBg;
		g.beginPath();
		g.roundRect(x + 6, y + 8, CELL_W - 12, 46, 14);
		g.fill();
		g.fillStyle = color;
		g.beginPath();
		g.roundRect(x + 6, y + 44, CELL_W - 12, 10, [0, 0, 14, 14]);
		g.fill();
		g.fillStyle = p.labelFg;
		let size = LABEL_FONT;
		const floor = Math.min(LABEL_FONT, Math.max(14, minSize));
		g.font = `700 ${size}px system-ui, "Noto Sans TC", sans-serif`;
		while (g.measureText(name).width > CELL_W - 40 && size > floor) {
			size -= 2;
			g.font = `700 ${size}px system-ui, "Noto Sans TC", sans-serif`;
		}
		// Cut with an ellipsis only once the smallest size no longer fits the plate.
		const shown = ellipsize(
			name,
			(text) => g.measureText(text).width <= CELL_W - 40,
		);
		g.textAlign = "center";
		g.textBaseline = "middle";
		g.fillText(shown, x + CELL_W / 2, y + 28);
		this.tex.needsUpdate = true;
	}
}

function svgToImage(svg: string): Promise<HTMLImageElement> {
	const withSize = /<svg[^>]*\swidth=/.test(svg)
		? svg
		: svg.replace("<svg", '<svg width="256" height="256"');
	const img = new Image();
	img.decoding = "async";
	img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withSize)}`;
	return img.decode().then(() => img);
}

/* ---------- seats ---------- */

interface Seat {
	id: string;
	name: string;
	hex: string;
	color: Color;
	state: SeatState;
	since: number;
	x: number;
	z: number;
	cx: number;
	cz: number;
	phase: number;
	// smoothed visual channels
	ring: number;
	halo: number;
	spot: number;
	mote: number;
	icon: number;
	kind: number;
	hover: number;
	tint: number;
	svg?: string;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const damp = (v: number, target: number, k: number, dt: number) =>
	v + (target - v) * (1 - Math.exp(-k * dt));
const pulse = (x: number) => 0.5 + 0.5 * Math.sin(x);

const LIVE: ReadonlySet<SeatState> = new Set([
	"thinking",
	"working",
	"waiting",
	"speaking",
]);

export function createTable3D(
	container: HTMLElement,
	opts: TableOptions,
	onLost?: () => void,
): TableHandle {
	const mqReduced = window.matchMedia("(prefers-reduced-motion: reduce)");
	let reduced =
		opts.reducedMotion === "auto" || opts.reducedMotion === undefined
			? mqReduced.matches
			: opts.reducedMotion;
	const coarse = window.matchMedia("(pointer: coarse)").matches;
	const lowPower =
		opts.lowPower === "auto" || opts.lowPower === undefined
			? coarse ||
				Math.min(container.clientWidth || innerWidth, innerWidth) < 700 ||
				(navigator.hardwareConcurrency || 8) <= 4
			: opts.lowPower;
	const dprCap = lowPower ? 1.5 : 2;

	const renderer = new WebGLRenderer({
		antialias: !lowPower,
		alpha: false,
		powerPreference: lowPower ? "default" : "high-performance",
	});
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
	const canvasEl = renderer.domElement;
	canvasEl.style.cssText =
		"display:block;width:100%;height:100%;touch-action:none;outline:none;cursor:grab";
	canvasEl.setAttribute("aria-hidden", "true");
	if (getComputedStyle(container).position === "static")
		container.style.position = "relative";
	container.appendChild(canvasEl);

	const scene = new Scene();
	const camera = new PerspectiveCamera(34, 1, 0.5, 80);
	const hemi = new HemisphereLight();
	const key = new DirectionalLight();
	key.position.set(-5, 11, 6);
	const candleLight = new PointLight(0xffffff, 0, 14, 2);
	candleLight.position.set(0, 2.6, 0);
	scene.add(hemi, key, candleLight);

	/* textures (shared by every theme) */
	const mk = (c: HTMLCanvasElement, repeat = 1, srgb = true) => {
		const t = new CanvasTexture(c);
		if (srgb) t.colorSpace = SRGBColorSpace;
		t.wrapS = t.wrapT = RepeatWrapping;
		t.repeat.set(repeat, repeat);
		t.anisotropy = lowPower ? 2 : 4;
		return t;
	};
	const texWood = mk(woodCanvas(), 2);
	const texStone = mk(stoneCanvas(), 9);
	const texPlain = mk(plainCanvas(), 3);
	const texGlow = mk(glowCanvas());
	const texShaft = mk(shaftCanvas());
	const texIcons = mk(iconsCanvas());
	const texRune = mk(runeCanvas());
	const texRing = mk(ringCanvas());
	for (const t of [texGlow, texShaft, texIcons, texRune, texRing])
		t.wrapS = t.wrapT = ClampToEdgeWrapping;

	/* materials, all shared */
	const matFloor = new MeshLambertMaterial({ map: texPlain });
	const matTable = new MeshLambertMaterial({ map: texWood });
	const matRim = new MeshLambertMaterial();
	const matPed = new MeshLambertMaterial();
	const matStool = new MeshLambertMaterial({ map: texWood });
	const matInlay = new MeshLambertMaterial({
		map: texRing,
		transparent: true,
		depthWrite: false,
		polygonOffset: true,
		polygonOffsetFactor: -2,
		polygonOffsetUnits: -2,
	});
	const matCandle = new MeshLambertMaterial({ color: 0xf4ead2 });
	const matCenter = new MeshLambertMaterial();

	const atlas = new Atlas();
	atlas.resize(1, lowPower ? 2 : 4);
	const matAvatar = new MeshBasicMaterial({
		map: atlas.tex,
		alphaTest: 0.45,
		side: 2,
		fog: false,
	});
	// The plate is a billboard in front of the scene: the tabletop must not cut the names of the seats behind it.
	const matLabel = new MeshBasicMaterial({
		map: atlas.tex,
		alphaTest: 0.45,
		transparent: true,
		fog: false,
		depthTest: false,
		depthWrite: false,
	});
	const matIcon = new MeshBasicMaterial({
		map: texIcons,
		alphaTest: 0.45,
		side: 2,
		fog: false,
	});
	const glowMat = (map: CanvasTexture) =>
		new MeshBasicMaterial({
			map,
			transparent: true,
			depthWrite: false,
			fog: false,
			blending: AdditiveBlending,
		});
	const matGlow = glowMat(texGlow);
	const matShaft = glowMat(texShaft);
	const matShadow = new MeshBasicMaterial({
		map: texGlow,
		color: 0x000000,
		transparent: true,
		depthWrite: false,
		fog: false,
	});

	/* static scenery */
	const floor = new Mesh(new CircleGeometry(1, 64), matFloor);
	floor.rotation.x = -Math.PI / 2;
	scene.add(floor);
	const matRug = new MeshLambertMaterial({ map: texPlain });
	const rug = new Mesh(new CircleGeometry(1, 64), matRug);
	rug.rotation.x = -Math.PI / 2;
	rug.position.y = 0.004;
	scene.add(rug);
	const matRugEdge = new MeshLambertMaterial({
		transparent: true,
		depthWrite: false,
	});
	const rugEdge = new Mesh(new CircleGeometry(1, 64), matRugEdge);
	rugEdge.rotation.x = -Math.PI / 2;
	rugEdge.position.y = 0.002;
	scene.add(rugEdge);
	const tableGroup = new Mesh();
	scene.add(tableGroup);
	let tableMeshes: Mesh[] = [];
	const flat = new Quaternion().setFromEuler(new Euler(-Math.PI / 2, 0, 0));

	const stools = new InstancedMesh(
		new CylinderGeometry(0.52, 0.56, STOOL_H, 28),
		matStool,
		MAXS,
	);
	stools.frustumCulled = false;
	scene.add(stools);
	const candles = new InstancedMesh(
		new CylinderGeometry(0.05, 0.055, 0.3, 8),
		matCandle,
		MAXS + 3,
	);
	candles.frustumCulled = false;
	scene.add(candles);

	const goblet = new Mesh(
		new LatheGeometry(
			[
				[0.001, 0],
				[0.3, 0],
				[0.26, 0.07],
				[0.09, 0.16],
				[0.07, 0.42],
				[0.22, 0.5],
				[0.24, 0.56],
				[0.16, 0.54],
				[0.001, 0.52],
			].map(([x, y]) => new Vector2(x, y)),
			16,
		),
		matCenter,
	);
	const bowl = new Mesh(
		new LatheGeometry(
			[
				[0.001, 0],
				[0.18, 0],
				[0.34, 0.05],
				[0.44, 0.2],
				[0.4, 0.2],
				[0.3, 0.09],
				[0.001, 0.08],
			].map(([x, y]) => new Vector2(x, y)),
			24,
		),
		matCenter,
	);
	goblet.position.y = bowl.position.y = TABLE_Y;
	scene.add(goblet, bowl);
	const inlay = new Mesh(new CircleGeometry(1, 64), matInlay);
	inlay.rotation.x = -Math.PI / 2;
	inlay.position.y = TABLE_Y + 0.004;
	scene.add(inlay);

	/* instanced overlays */
	const quad = () => {
		const g = new PlaneGeometry(1, 1);
		return g;
	};
	const baseQuad = () => {
		const g = new PlaneGeometry(1, 1);
		g.translate(0, 0.5, 0);
		return g;
	};
	const lShadow = new Layer(quad(), matShadow, MAXS + 1, 1);
	const lAvatar = new Layer(baseQuad(), matAvatar, MAXS, 2);
	const lLabel = new Layer(quad(), matLabel, MAXS, 7);
	const lIcon = new Layer(quad(), matIcon, MAXS, 4);
	const lGlow = new Layer(quad(), matGlow, MAXS * G + 3, 6);
	const lShaft = new Layer(baseQuad(), matShaft, MAXS, 5);
	for (const l of [lShadow, lAvatar, lLabel, lIcon, lGlow, lShaft])
		scene.add(l.mesh);

	/* ----- state ----- */
	let pal: Palette = palette(opts.theme, opts.scheme);
	let themeName: ThemeName = opts.theme;
	let schemeName: Scheme = opts.scheme;
	const seats: Seat[] = [];
	const byId = new Map<string, Seat>();
	const imgCache = new Map<string, HTMLImageElement>();
	let seatR = 3.1;
	let K = 1; // avatar scale: shrinks as the table fills so neighbours do not overlap
	let tableR = 2.3;
	/** How the name plates stand: how much larger than their base size, and whether they carry names. */
	let plan: PlatePlan = { scale: 1, names: true, px: MIN_NAME_PX };
	let planKey = "";
	/** The seat each plate slot shows, far to near; a plate of a nearer seat is drawn after a farther one's. */
	let slotOf: number[] = [];
	let slotKey = "";
	let width = 1;
	let height = 1;
	let disposed = false;
	let tSec = 0;
	const t0 = performance.now();

	const cam = { az: 0, el: 0.66, zoom: 1 };
	const tgt = { az: 0, el: 0.66, zoom: 1 };
	const vel = { az: 0 };
	const par = { x: 0, y: 0, tx: 0, ty: 0 };
	let fit = 14;
	let ambient = 0; // fades 1 -> 0 over the ambient window so the final frame is seamless
	let ambientUntil = 0;
	let animUntil = 0;
	let hover = -1;
	let paused = false;
	let visible = true;
	let loop: TableStats["loop"] = "idle";
	let rafId = 0;
	let lastRender = 0;
	const frameTimes: number[] = [];
	const renderStamps: number[] = [];
	let renders = 0;
	let maxMs = 0;

	const qBill = new Quaternion();
	const qTmp = new Quaternion();
	const vP = new Vector3();
	const vF = new Vector3();
	const vR = new Vector3();
	const eul = new Euler(0, 0, 0, "YXZ");
	const zAxis = new Vector3(0, 0, 1);
	const UNIT = new Quaternion();

	/* ----- layout ----- */
	function buildTable() {
		for (const m of tableMeshes) {
			scene.remove(m);
			m.geometry.dispose();
		}
		const top = new Mesh(
			new CylinderGeometry(tableR, tableR, 0.14, 64),
			matTable,
		);
		top.position.y = TABLE_Y - 0.07;
		const rim = new Mesh(new TorusGeometry(tableR, 0.075, 8, 72), matRim);
		rim.rotation.x = Math.PI / 2;
		rim.position.y = TABLE_Y - 0.06;
		const stem = new Mesh(
			new CylinderGeometry(0.42, 0.62, TABLE_Y - 0.14, 14),
			matPed,
		);
		stem.position.y = (TABLE_Y - 0.14) / 2;
		const foot = new Mesh(new CylinderGeometry(1.15, 1.3, 0.1, 28), matPed);
		foot.position.y = 0.05;
		tableMeshes = [top, rim, stem, foot];
		scene.add(...tableMeshes);
		inlay.scale.setScalar(tableR * 0.5);
		rug.scale.setScalar(seatR + 1.25);
		rugEdge.scale.setScalar(seatR + 1.45);
		stools.count = seats.length;
	}

	function layout() {
		const n = Math.max(seats.length, 1);
		K = n <= 6 ? 1 : n <= 9 ? 0.88 : 0.78;
		seatR = Math.max(3.1, (n * 2.35 * K) / (Math.PI * 2));
		tableR = seatR - 0.9;
		buildTable();
		atlas.resize(n, lowPower ? 2 : 4);
		matAvatar.map = atlas.tex;
		matLabel.map = atlas.tex;
		seats.forEach((s, i) => {
			const a = Math.PI + (i / n) * Math.PI * 2;
			s.x = Math.sin(a) * seatR;
			s.z = Math.cos(a) * seatR;
			s.cx = Math.sin(a) * tableR * 0.74;
			s.cz = Math.cos(a) * tableR * 0.74;
			s.phase = i * 1.7;
			redrawSeat(s, i);
		});
		const m = new Matrix4();
		seats.forEach((s, i) => {
			m.makeTranslation(s.x, STOOL_H / 2, s.z).scale(new Vector3(K, 1, K));
			stools.setMatrixAt(i, m);
		});
		stools.instanceMatrix.needsUpdate = true;
		stools.count = seats.length;
		applyMarkers();
		for (const l of [lShadow, lAvatar, lLabel, lIcon, lGlow, lShaft])
			l.mesh.count = 0;
		lAvatar.mesh.count =
			lLabel.mesh.count =
			lIcon.mesh.count =
			lShaft.mesh.count =
				seats.length;
		lShadow.mesh.count = seats.length + 1;
		lGlow.mesh.count = seats.length * G + 3;
		seats.forEach((_, i) => {
			const [u, v, w, h] = atlas.avatarRect(i);
			lAvatar.uv(i, u, v, w, h);
		});
		// The plates' slots are given again by the next frame.
		slotKey = "";
		fit = fitDistance();
		planPlatesForCanvas();
		sizeFloor();
		wake();
	}

	/** The font size a name may shrink to on the plates as they stand now. */
	const minNameSize = () =>
		plan.px > 0 ? Math.ceil((MIN_NAME_PX * LABEL_FONT) / plan.px) : LABEL_FONT;

	function redrawLabel(s: Seat, i: number) {
		atlas.drawLabel(i, s.name, s.hex, pal, plan.names, minNameSize());
	}

	function redrawSeat(s: Seat, i: number) {
		const img = imgCache.get(s.id) ?? null;
		atlas.drawAvatar(i, img, s.name, s.hex);
		redrawLabel(s, i);
	}

	/**
	 * Works out how large the plates must stand for their names to be at least `MIN_NAME_PX` on this
	 * canvas, and redraws them when that changed. The page hears whether the names are readable at all:
	 * where they are not, it lists the seats under the table.
	 */
	function planPlatesForCanvas() {
		const n = Math.max(seats.length, 1);
		const tanV = Math.tan((camera.fov * Math.PI) / 360);
		// The far side of the ring is the smallest on the screen: a name readable there is readable everywhere.
		const far = fit + seatR * Math.cos(tgt.el);
		plan = planPlates({
			pxPerUnit: height / 2 / (far * tanV),
			plateWidth: 1.6 * K,
			gap: n === 1 ? 2 * seatR : 2 * seatR * Math.sin(Math.PI / n),
			fontCell: LABEL_FONT,
			cellWidth: CELL_W,
		});
		const key = `${plan.names}|${plan.scale.toFixed(2)}|${minNameSize()}`;
		if (key !== planKey) {
			planKey = key;
			seats.forEach(redrawLabel);
		}
		opts.onNames?.(plan.names);
	}

	function sizeFloor() {
		const R = Math.max(30, fit * 2);
		floor.scale.setScalar(R);
		texStone.repeat.setScalar(R / 2.2);
		texPlain.repeat.setScalar(R / 6);
	}

	function applyMarkers() {
		const m = new Matrix4();
		const q = new Quaternion();
		const sc = new Vector3();
		const p = new Vector3();
		seats.forEach((s, i) => {
			p.set(s.cx, pal.candles ? TABLE_Y + 0.15 : TABLE_Y + 0.025, s.cz);
			sc.set(
				pal.candles ? 1 : 1.9,
				pal.candles ? 1 : 0.14,
				pal.candles ? 1 : 1.9,
			);
			m.compose(p, q, sc);
			candles.setMatrixAt(i, m);
		});
		// centre candelabra
		for (let k = 0; k < 3; k++) {
			const a = (k / 3) * Math.PI * 2;
			p.set(Math.sin(a) * 0.17, TABLE_Y + 0.62, Math.cos(a) * 0.17);
			sc.set(
				pal.candles ? 0.9 : 0,
				pal.candles ? 0.7 : 0,
				pal.candles ? 0.9 : 0,
			);
			m.compose(p, q, sc);
			candles.setMatrixAt(seats.length + k, m);
		}
		candles.count = seats.length + 3;
		candles.instanceMatrix.needsUpdate = true;
		goblet.visible = pal.candles;
		bowl.visible = !pal.candles;
		// shadows: table first, then stools (static)
		vP.set(0, 0.006, 0);
		lShadow.put(0, vP, flat, tableR * 2.9);
		lShadow.a(0, pal.shadow);
		seats.forEach((s, i) => {
			vP.set(s.x, 0.006, s.z);
			lShadow.put(i + 1, vP, flat, 1.7 * K);
			lShadow.a(i + 1, pal.shadow * 0.9);
		});
		lShadow.flush();
	}

	function applyTheme() {
		pal = palette(themeName, schemeName);
		const bg = new Color(pal.bg);
		scene.background = bg;
		scene.fog = new Fog(bg, 20, 44);
		matFloor.color.set(pal.floor);
		matFloor.map = pal.floorTex === "stone" ? texStone : texPlain;
		matTable.color.set(pal.table);
		matRim.color.set(pal.rim);
		matPed.color.set(pal.pedestal);
		matStool.color.set(pal.stool);
		matCenter.color
			.set(pal.candles ? pal.rim : pal.pedestal)
			.lerp(new Color(0xffffff), pal.candles ? 0 : 0.35);
		matInlay.color.set(pal.inlay);
		matRug.color.set(pal.rug);
		matRugEdge.color.set(pal.rugEdge);
		matInlay.map = pal.inlayTex === "rune" ? texRune : texRing;
		matInlay.opacity = pal.candles ? 0.9 : 0.55;
		hemi.color.set(pal.hemiSky);
		hemi.groundColor.set(pal.hemiGround);
		hemi.intensity = pal.hemiI;
		key.color.set(pal.keyColor);
		key.intensity = pal.keyI;
		candleLight.color.set(pal.pointColor);
		candleLight.intensity = pal.pointI;
		const blend = pal.glowBlend === "add" ? AdditiveBlending : NormalBlending;
		for (const m of [matGlow, matShaft]) {
			m.blending = blend;
			m.needsUpdate = true;
		}
		matShadow.opacity = 1;
		applyMarkers();
		seats.forEach(redrawLabel);
		applyMarkers();
	}

	/* ----- camera ----- */
	let pan = 0;
	/**
	 * Fits the whole ring (stools to floating icons) inside the viewport at elevation `el`: the
	 * distance, a view-space pan that balances the near and far margins, and how much of the height
	 * the ring then fills (1 = all of it).
	 */
	function solveFit(el: number): { d: number; pz: number; fill: number } {
		const R = seatR + 0.5;
		const pts: Vector3[] = [];
		for (let k = 0; k < 24; k++) {
			const a = (k / 24) * Math.PI * 2;
			pts.push(
				new Vector3(Math.sin(a) * R, 0, Math.cos(a) * R),
				new Vector3(
					Math.sin(a) * R,
					AV_Y + AV + 0.75 + LIFT_MAX,
					Math.cos(a) * R,
				),
			);
		}
		const cam2 = new PerspectiveCamera(camera.fov, width / height, 0.5, 80);
		const lim = width / height < 0.8 ? 0.9 : 0.93;
		const v = new Vector3();
		const eval2 = (d: number, pz: number) => {
			cam2.position.set(
				0,
				camTarget.y + d * Math.sin(el),
				pz + d * Math.cos(el),
			);
			cam2.lookAt(0, camTarget.y, pz);
			cam2.updateMatrixWorld();
			cam2.updateProjectionMatrix();
			let x = 0;
			let y0 = Infinity;
			let y1 = -Infinity;
			for (const p of pts) {
				v.copy(p).project(cam2);
				x = Math.max(x, Math.abs(v.x));
				y0 = Math.min(y0, v.y);
				y1 = Math.max(y1, v.y);
			}
			return { x, y0, y1 };
		};
		const tanV = Math.tan((camera.fov * Math.PI) / 360);
		let lo = 4;
		let hi = 70;
		let best = { d: hi, pz: 0, fill: 0 };
		for (let it = 0; it < 22; it++) {
			const d = (lo + hi) / 2;
			let pz = 0;
			let e = eval2(d, pz);
			for (let k = 0; k < 4; k++) {
				pz -= (((e.y0 + e.y1) / 2) * d * tanV) / Math.sin(el);
				e = eval2(d, pz);
			}
			if (e.x <= lim && (e.y1 - e.y0) / 2 <= lim) {
				hi = d;
				best = { d, pz, fill: (e.y1 - e.y0) / 2 };
			} else lo = d;
		}
		return best;
	}

	/** The distance that fits the ring at the current elevation; also sets the pan. */
	function fitDistance(): number {
		const best = solveFit(tgt.el);
		pan = best.pz;
		return best.d;
	}

	/**
	 * The elevation a fresh view starts at. A wide canvas keeps the low, wide view; a squarer or
	 * taller one is looked at from higher up, only as high as it takes for the ring (with the
	 * avatars standing on it) to fill its height, so no empty band is left above the far seats.
	 */
	function defaultElevation(): number {
		if (width / height >= 1.3) return 0.68;
		// The icons float above the avatars, so the fitted ring is taller than what shows: ask for more than the band needs.
		for (let el = 0.68; el < 1.3; el += 0.04)
			if (solveFit(el).fill >= 0.88) return el;
		return 1.3;
	}

	function resetCamera() {
		tgt.az = 0;
		tgt.el = defaultElevation();
		tgt.zoom = 1;
		vel.az = 0;
		fit = fitDistance();
		if (reduced) {
			cam.az = tgt.az;
			cam.el = tgt.el;
			cam.zoom = tgt.zoom;
		}
		wake();
	}

	const camTarget = new Vector3(0, 1.1, 0);
	function placeCamera(sway: number) {
		const az = cam.az + par.x * 0.12 + sway;
		const el = clamp(cam.el + par.y * 0.05, 0.3, 1.3);
		const d = fit * cam.zoom;
		vF.set(Math.sin(az), 0, Math.cos(az));
		vR.set(Math.cos(az), 0, -Math.sin(az));
		camTarget.set(vF.x * pan, 1.1, vF.z * pan);
		camera.position.set(
			camTarget.x + d * Math.cos(el) * Math.sin(az),
			camTarget.y + d * Math.sin(el),
			camTarget.z + d * Math.cos(el) * Math.cos(az),
		);
		camera.lookAt(camTarget);
		camera.updateMatrixWorld();
		const fog = scene.fog as Fog;
		fog.near = d + seatR + 4;
		fog.far = d + seatR + 26;
		eul.set(-el * 0.45, az, 0);
		qBill.setFromEuler(eul);
	}

	/* ----- per-frame update ----- */
	const white = new Color(1, 1, 1);
	const warm = new Color();
	const tmpC = new Color();
	const errC = new Color(STATE_COLOR.error);
	const okC = new Color(STATE_COLOR.done);

	function update(t: number, dt: number) {
		const k = reduced ? 1000 : 1;
		const amb = reduced ? 0 : ambient;
		// camera easing
		cam.az = damp(cam.az, tgt.az, 9 * k, dt);
		cam.el = damp(cam.el, tgt.el, 9 * k, dt);
		cam.zoom = damp(cam.zoom, tgt.zoom, 9 * k, dt);
		par.x = damp(par.x, par.tx, 4 * k, dt);
		par.y = damp(par.y, par.ty, 4 * k, dt);
		if (Math.abs(vel.az) > 0.004) {
			tgt.az += vel.az * dt;
			vel.az *= Math.exp(-3.5 * dt);
		} else vel.az = 0;
		placeCamera(Math.sin(t * 0.22) * 0.07 * amb);

		const anySpeaking = seats.some((s) => s.state === "speaking");
		warm.set(pal.flame);
		const flameBase = pal.flameI;
		const flick = reduced
			? 0.8
			: 0.8 + 0.2 * Math.sin(t * 13) * Math.sin(t * 7.3 + 1);
		candleLight.intensity =
			pal.pointI *
			(reduced ? 1 : 0.94 + 0.06 * Math.sin(t * 9) * Math.sin(t * 4.1));
		const n = seats.length;
		// Plates are drawn far to near, in slots of the instanced layer; the slots change when the view turns.
		const order = plateOrder(seats.map((s) => s.x * vF.x + s.z * vF.z));
		const orderKey = order.join(",");
		if (orderKey !== slotKey) {
			slotKey = orderKey;
			slotOf = [];
			order.forEach((seat, slot) => {
				slotOf[seat] = slot;
				const [lu, lv, lw, lh] = atlas.labelRect(seat);
				lLabel.uv(slot, lu, lv, lw, lh);
			});
		}

		for (let i = 0; i < n; i++) {
			const s = seats[i]!;
			const age = t - s.since;
			const sp = s.state;
			const live = LIVE.has(sp);
			const ph = s.phase;
			const ax = s.x + vF.x * ANCH;
			const az2 = s.z + vF.z * ANCH;
			// targets
			let ring = 0;
			let halo = 0;
			let spot = 0;
			let mote = 0;
			let icon = 0;
			let bob = 0;
			let sx = 0;
			let lean = 0;
			let scaleY = 1;
			let scaleXY = 1;
			let tint = anySpeaking && sp !== "speaking" ? 0.8 : 1;
			let ringC: Color = s.color;
			let icoC: Color = s.color;
			if (sp === "idle") {
				scaleY += 0.014 * Math.sin(t * 1.6 + ph) * amb;
			} else if (sp === "thinking") {
				mote = 1;
				halo = 0.16;
				ring = 0.15;
				scaleY += 0.008 * Math.sin(t * 2.2 + ph) * amb;
				lean = 0.04 * Math.sin(t * 1.3 + ph) * amb;
			} else if (sp === "working") {
				const p = reduced ? 0.75 : pulse(t * 5.5 + ph);
				ring = 0.45 + 0.45 * p;
				halo = 0.22 + 0.2 * p;
				bob = reduced ? 0 : 0.045 * Math.abs(Math.sin(t * 5.5 + ph));
			} else if (sp === "waiting") {
				const p = reduced ? 0.8 : pulse(t * 3.3 + ph);
				ring = 0.55 + 0.4 * p;
				halo = 0.42 + 0.3 * p;
				icon = 1;
				lean = reduced ? -0.12 : -0.12 - 0.04 * Math.sin(t * 3.3 + ph);
				s.kind = 0;
			} else if (sp === "speaking") {
				spot = 1;
				halo = reduced ? 0.8 : 0.72 + 0.12 * Math.sin(t * 7 + ph);
				ring = 0.5;
				tint = 1.25;
				scaleY += reduced ? 0 : 0.02 * Math.sin(t * 9 + ph);
			} else if (sp === "done") {
				icon = 1;
				s.kind = 1;
				icoC = okC;
				ringC = okC;
				ring = reduced ? 0.25 : 0.55 * Math.exp(-age * 1.2) + 0.12;
				if (!reduced && age < 0.6)
					scaleXY = 1 + 0.2 * Math.sin((age / 0.6) * Math.PI);
			} else {
				// error
				icon = 1;
				s.kind = 2;
				icoC = errC;
				ringC = errC;
				const f = reduced
					? 0.9
					: age < 2.2
						? 0.45 + 0.55 * Math.abs(Math.sin(t * 41) * Math.sin(t * 23 + 1))
						: 0.65;
				ring = 0.9 * f;
				halo = 0.5 * f;
				tint = 0.78 + 0.22 * f;
				if (!reduced && age < 0.5)
					sx = Math.sin(t * 70) * 0.05 * (1 - age / 0.5);
			}
			const hv = i === hover ? 1 : 0;
			s.hover = damp(s.hover, hv, 12 * k, dt);
			s.ring = damp(s.ring, ring, (ring > s.ring ? 14 : 6) * k, dt);
			s.halo = damp(s.halo, halo, 8 * k, dt);
			s.spot = damp(s.spot, spot, 7 * k, dt);
			s.mote = damp(s.mote, mote, 8 * k, dt);
			s.icon = damp(s.icon, icon, (icon > s.icon ? 10 : 8) * k, dt);
			s.tint = damp(s.tint, tint, 9 * k, dt);

			/* avatar */
			const hs = 1 + s.hover * 0.05;
			// A seat across the table stands a little higher, so the table's far edge does not cut its head.
			const lift = rearLift((s.x * vF.x + s.z * vF.z) / seatR, LIFT_MAX * K);
			vP.set(ax + vR.x * sx, AV_Y + lift + bob, az2 + vR.z * sx);
			qTmp.setFromAxisAngle(zAxis, 0);
			eul.set(
				-cam.el * 0.45 + lean,
				cam.az + par.x * 0.12 + Math.sin(t * 0.22) * 0.07 * amb,
				0,
			);
			qTmp.setFromEuler(eul);
			lAvatar.put(
				i,
				vP,
				qTmp,
				AV * K * scaleXY * hs,
				AV * K * scaleXY * hs * scaleY,
				1,
			);
			const redTint = sp === "error";
			lAvatar.col(
				i,
				s.tint,
				redTint ? s.tint * 0.62 : s.tint,
				redTint ? s.tint * 0.62 : s.tint,
			);

			/* name plate, nudged toward the camera so it sits on the stool front */
			vP.set(
				ax + vF.x * 0.2,
				0.2 + (plan.scale - 1) * 0.2 * K,
				az2 + vF.z * 0.2,
			);
			lLabel.put(
				slotOf[i] ?? i,
				vP,
				qBill,
				1.6 * K * hs * plan.scale,
				0.4 * K * hs * plan.scale,
				1,
			);
			lLabel.col(slotOf[i] ?? i, 1, 1, 1);

			/* icon badge: raised banner (waiting) / check (done) / cross (error) */
			if (s.icon > 0.02) {
				const rise = s.icon;
				const wob =
					sp === "waiting" && !reduced ? Math.sin(t * 4 + ph) * 0.1 : 0;
				vP.set(
					ax + vR.x * 0.66 * K + vF.x * 0.05,
					AV_Y +
						lift +
						(s.kind === 0 ? 1.2 + rise * 0.5 : 1.3 + rise * 0.15) * K +
						(sp === "waiting" && !reduced ? 0.04 * Math.sin(t * 3.3 + ph) : 0),
					az2 + vR.z * 0.66 * K + vF.z * 0.05,
				);
				qTmp.setFromAxisAngle(zAxis, wob);
				qTmp.premultiply(qBill);
				const size =
					(s.kind === 0 ? 0.62 : 0.46) *
					K *
					rise *
					(sp === "done" && !reduced && age < 0.5
						? 1 + 0.35 * Math.sin((age / 0.5) * Math.PI)
						: 1);
				lIcon.put(i, vP, qTmp, size, size, 1);
				lIcon.uv(i, s.kind / ICON_CELLS + 0.004, 0, 1 / ICON_CELLS - 0.008, 1);
				tmpC.copy(s.kind === 0 ? s.color : s.kind === 1 ? okC : errC);
				void icoC;
				lIcon.col(i, tmpC.r * 1.1, tmpC.g * 1.1, tmpC.b * 1.1);
			} else {
				lIcon.put(i, vP, UNIT, 0.0001, 0.0001, 1);
			}

			/* glow instances */
			const gain = pal.glowGain;
			const base = i * G;
			// halo behind the avatar
			vP.set(ax - vF.x * 0.12, AV_Y + lift + 0.85 * K, az2 - vF.z * 0.12);
			lGlow.put(base, vP, camera.quaternion, (3.0 + s.hover * 0.3) * K);
			lGlow.col(base, ringC.r, ringC.g, ringC.b);
			lGlow.a(base, clamp((s.halo + s.hover * 0.28) * gain, 0, 1));
			// stool ring on the floor
			vP.set(s.x, 0.012, s.z);
			lGlow.put(base + 1, vP, flat, 2.1 + s.ring * 0.25);
			lGlow.col(base + 1, ringC.r, ringC.g, ringC.b);
			lGlow.a(base + 1, clamp((s.ring + s.hover * 0.35) * gain, 0, 1));
			// light pool on the table at the candle
			const act = Math.max(s.spot, s.ring * 0.7);
			vP.set(s.cx, TABLE_Y + 0.012, s.cz);
			lGlow.put(base + 2, vP, flat, 0.95 + act * 0.7);
			tmpC.copy(warm).lerp(s.color, Math.min(1, act * 1.2));
			lGlow.col(base + 2, tmpC.r, tmpC.g, tmpC.b);
			lGlow.a(base + 2, clamp((0.14 * flameBase + act * 0.62) * gain, 0, 1));
			// flame (candle) or lamp bloom (puck)
			const fl = reduced
				? 0.8
				: 0.78 + 0.22 * Math.sin(t * 11 + ph * 3) * Math.sin(t * 6.1 + ph);
			vP.set(s.cx, pal.candles ? TABLE_Y + 0.38 : TABLE_Y + 0.07, s.cz);
			lGlow.put(
				base + 3,
				vP,
				camera.quaternion,
				(pal.candles ? 0.34 : 0.4) * (1 + s.spot * 0.9) * (0.9 + 0.1 * fl),
			);
			lGlow.col(base + 3, warm.r, warm.g, warm.b);
			lGlow.a(
				base + 3,
				clamp((flameBase * (0.55 + 0.45 * fl) + s.spot * 0.6) * gain, 0, 1),
			);
			// thinking motes
			for (let j = 0; j < 3; j++) {
				const a = (reduced ? 0 : t * 2.3) + j * 2.1 + ph;
				vP.set(
					ax + Math.cos(a) * 0.74 * K,
					AV_Y + lift + 1.55 * K + Math.sin(a * 2) * 0.07 + j * 0.05,
					az2 + Math.sin(a) * 0.74 * K,
				);
				lGlow.put(base + 4 + j, vP, camera.quaternion, (0.36 - j * 0.07) * K);
				tmpC.copy(s.color).lerp(white, pal.glowBlend === "add" ? 0.45 : 0);
				lGlow.col(base + 4 + j, tmpC.r, tmpC.g, tmpC.b);
				lGlow.a(
					base + 4 + j,
					clamp(
						s.mote * (0.95 - j * 0.22) * (pal.glowBlend === "add" ? 1 : 1),
						0,
						1,
					),
				);
			}
			// spotlight shaft (speaking)
			vP.set(ax - vF.x * 0.2, AV_Y - 0.05, az2 - vF.z * 0.2);
			lShaft.put(i, vP, qBill, 2.2 * K, 3.6 * (0.55 + 0.45 * s.spot), 1);
			tmpC.copy(s.color).lerp(white, 0.4);
			lShaft.col(i, tmpC.r, tmpC.g, tmpC.b);
			lShaft.a(i, clamp(s.spot * 0.7 * gain, 0, 1));
		}
		// centre candelabra flames
		const cb = n * G;
		for (let k2 = 0; k2 < 3; k2++) {
			if (!pal.candles) {
				lGlow.hide(cb + k2);
				continue;
			}
			const a = (k2 / 3) * Math.PI * 2;
			const ff = reduced
				? 0.8
				: 0.75 + 0.25 * Math.sin(t * 10 + k2 * 2) * Math.sin(t * 5.3 + k2);
			vP.set(Math.sin(a) * 0.17, TABLE_Y + 1.03, Math.cos(a) * 0.17);
			lGlow.put(cb + k2, vP, camera.quaternion, 0.3 * (0.9 + 0.1 * ff));
			lGlow.col(cb + k2, warm.r, warm.g, warm.b);
			lGlow.a(
				cb + k2,
				clamp((flameBase * (0.5 + 0.4 * ff) + 0.05) * pal.glowGain, 0, 1),
			);
		}
		for (const l of [lAvatar, lLabel, lIcon, lGlow, lShaft]) l.flush();
		void flick;
	}

	/* ----- loop ----- */
	const liveCount = () =>
		seats.reduce((c, s) => c + (LIVE.has(s.state) ? 1 : 0), 0);

	function wake(ms = AMBIENT_MS) {
		if (disposed) return;
		ambientUntil = Math.max(ambientUntil, performance.now() + ms);
		schedule();
	}

	function schedule() {
		if (rafId || disposed || paused || !visible) return;
		loop = "live";
		rafId = requestAnimationFrame(frame);
	}

	const camSettling = () =>
		Math.abs(cam.az - tgt.az) > 6e-4 ||
		Math.abs(cam.el - tgt.el) > 6e-4 ||
		Math.abs(cam.zoom - tgt.zoom) > 6e-4 ||
		Math.abs(par.x - par.tx) > 2e-3 ||
		Math.abs(par.y - par.ty) > 2e-3 ||
		vel.az !== 0;

	function frame(ts: number) {
		rafId = 0;
		if (disposed) return;
		const live = liveCount() > 0;
		const interacting = ptrs.size > 0 || camSettling();
		const recent = frameTimes.slice(-30);
		const slow =
			recent.length >= 30 &&
			recent.reduce((a, b) => a + b, 0) / recent.length > 9; // CPU cost eats over half a 60 fps budget: halve the rate
		const minInterval = interacting ? 0 : slow ? 32 : live ? 0 : 42;
		if (lastRender && ts - lastRender < minInterval - 3) {
			rafId = requestAnimationFrame(frame);
			return;
		}
		const dt = lastRender ? Math.min((ts - lastRender) / 1000, 0.1) : 1 / 60;
		lastRender = ts;
		tSec = (ts - t0) / 1000;
		const remain = ambientUntil - ts;
		ambient = reduced ? 0 : clamp(remain / 1500, 0, 1);
		const c0 = performance.now();
		update(tSec, dt);
		renderer.render(scene, camera);
		const ms = performance.now() - c0;
		renders++;
		frameTimes.push(ms);
		if (frameTimes.length > 120) frameTimes.shift();
		renderStamps.push(ts);
		while (renderStamps.length && ts - renderStamps[0]! > 1000)
			renderStamps.shift();
		maxMs = Math.max(maxMs * 0.98, ms);
		const keepGoing =
			ptrs.size > 0 ||
			camSettling() ||
			(!reduced && (live || remain > 0 || ts < animUntil));
		if (keepGoing) {
			loop = "live";
			rafId = requestAnimationFrame(frame);
		} else {
			loop = "idle";
			lastRender = 0;
		}
	}

	/* ----- sizing / visibility ----- */
	function resize() {
		const w = Math.max(container.clientWidth, 1);
		const h = Math.max(container.clientHeight, 1);
		if (w === width && h === height) return;
		width = w;
		height = h;
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		const wasDefault = Math.abs(tgt.zoom - 1) < 1e-3;
		fit = fitDistance();
		if (wasDefault && Math.abs(tgt.az) < 1e-3) tgt.el = defaultElevation();
		if (reduced) cam.el = tgt.el;
		fit = fitDistance();
		planPlatesForCanvas();
		sizeFloor();
		wake(1500);
	}
	const ro = new ResizeObserver(resize);
	ro.observe(container);
	const io = new IntersectionObserver((es) => {
		visible = es[es.length - 1]!.isIntersecting;
		if (!visible) {
			cancelAnimationFrame(rafId);
			rafId = 0;
			lastRender = 0;
			loop = "paused";
		} else wake(1500);
	});
	io.observe(canvasEl);
	const onVis = () => {
		paused = document.hidden;
		if (paused) {
			cancelAnimationFrame(rafId);
			rafId = 0;
			lastRender = 0;
			loop = "paused";
		} else wake(1500);
	};
	document.addEventListener("visibilitychange", onVis);
	const onMq = () => {
		if (opts.reducedMotion === "auto" || opts.reducedMotion === undefined)
			api.setReducedMotion(mqReduced.matches);
	};
	mqReduced.addEventListener("change", onMq);
	canvasEl.addEventListener("webglcontextlost", (e) => {
		e.preventDefault();
		onLost?.();
	});

	/* ----- pointer: tap a seat, drag to rotate, wheel/pinch to zoom ----- */
	interface Ptr {
		x: number;
		y: number;
		sx: number;
		sy: number;
		t: number;
		moved: boolean;
	}
	const ptrs = new Map<number, Ptr>();
	let pinch0 = 0;
	let zoom0 = 1;
	const proj = new Vector3();

	function hitTest(clientX: number, clientY: number): number {
		const r = canvasEl.getBoundingClientRect();
		const px = clientX - r.left;
		const py = clientY - r.top;
		let best = -1;
		let bestD = Infinity;
		seats.forEach((s, i) => {
			const toScreen = (y: number, dx = 0) => {
				proj
					.set(s.x + vF.x * ANCH + dx * vR.x, y, s.z + vF.z * ANCH + dx * vR.z)
					.project(camera);
				return {
					x: ((proj.x + 1) / 2) * r.width,
					y: ((1 - proj.y) / 2) * r.height,
					z: proj.z,
				};
			};
			const top = toScreen(AV_Y + AV * K);
			const bot = toScreen(0.12);
			const mid = toScreen(AV_Y + 0.7);
			const hgt = bot.y - top.y;
			const half = Math.max(hgt * 0.34, 24);
			if (
				Math.abs(px - mid.x) <= half &&
				py >= top.y - 6 &&
				py <= bot.y + 10 &&
				mid.z < bestD
			) {
				best = i;
				bestD = mid.z;
			}
		});
		return best;
	}

	function setHover(i: number) {
		if (i === hover) return;
		hover = i;
		canvasEl.style.cursor =
			i >= 0 ? "pointer" : ptrs.size ? "grabbing" : "grab";
		wake(1200);
	}

	canvasEl.addEventListener("pointerdown", (e) => {
		canvasEl.setPointerCapture(e.pointerId);
		ptrs.set(e.pointerId, {
			x: e.clientX,
			y: e.clientY,
			sx: e.clientX,
			sy: e.clientY,
			t: performance.now(),
			moved: false,
		});
		if (ptrs.size === 2) {
			const [a, b] = [...ptrs.values()];
			pinch0 = Math.hypot(a!.x - b!.x, a!.y - b!.y);
			zoom0 = tgt.zoom;
			for (const p of ptrs.values()) p.moved = true;
		}
		vel.az = 0;
		wake();
	});
	canvasEl.addEventListener("pointermove", (e) => {
		const p = ptrs.get(e.pointerId);
		if (p) {
			const dx = e.clientX - p.x;
			const dy = e.clientY - p.y;
			p.x = e.clientX;
			p.y = e.clientY;
			if (ptrs.size === 1) {
				if (!p.moved && Math.hypot(p.x - p.sx, p.y - p.sy) > 6) p.moved = true;
				if (p.moved) {
					tgt.az -= dx * 0.0075;
					tgt.el = clamp(tgt.el + dy * 0.0045, 0.35, 1.25);
					vel.az = clamp((-dx * 0.0075) / Math.max(1 / 60, 0.016), -3, 3) * 0.5;
					canvasEl.style.cursor = "grabbing";
				}
			} else if (ptrs.size === 2) {
				const [a, b] = [...ptrs.values()];
				const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
				if (pinch0 > 0) tgt.zoom = clamp(zoom0 * (pinch0 / d), 0.55, 1.35);
				vel.az = 0;
			}
			wake();
		} else if (e.pointerType === "mouse") {
			const r = canvasEl.getBoundingClientRect();
			par.tx = ((e.clientX - r.left) / r.width - 0.5) * 2;
			par.ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
			setHover(hitTest(e.clientX, e.clientY));
			wake(2500);
		}
	});
	const end = (e: PointerEvent) => {
		const p = ptrs.get(e.pointerId);
		if (!p) return;
		ptrs.delete(e.pointerId);
		if (
			e.type === "pointerup" &&
			!p.moved &&
			performance.now() - p.t < 700 &&
			ptrs.size === 0
		) {
			const i = hitTest(e.clientX, e.clientY);
			if (i >= 0) {
				const s = seats[i]!;
				opts.onSeatClick({ id: s.id, name: s.name });
				wake(1500);
			}
		}
		if (ptrs.size < 2) pinch0 = 0;
		if (e.pointerType !== "mouse") vel.az *= 0.6;
		else vel.az = Math.abs(vel.az) < 0.05 ? 0 : vel.az;
		canvasEl.style.cursor = hover >= 0 ? "pointer" : "grab";
		wake(2000);
	};
	canvasEl.addEventListener("pointerup", end);
	canvasEl.addEventListener("pointercancel", end);
	canvasEl.addEventListener("pointerleave", (e) => {
		if (e.pointerType === "mouse" && !ptrs.size) {
			par.tx = par.ty = 0;
			setHover(-1);
		}
	});
	canvasEl.addEventListener(
		"wheel",
		(e) => {
			e.preventDefault();
			tgt.zoom = clamp(tgt.zoom * Math.exp(e.deltaY * 0.0012), 0.55, 1.35);
			wake(2000);
		},
		{ passive: false },
	);

	/* ----- a11y: a real button per seat, mirrored from the scene ----- */
	const sr = document.createElement("ul");
	sr.style.cssText =
		"position:absolute;inset:auto auto 0 0;width:1px;height:1px;overflow:hidden;margin:0;padding:0;list-style:none";
	sr.setAttribute("aria-label", "Round table");
	if (!opts.listBelow) container.appendChild(sr);
	function syncSr() {
		sr.replaceChildren(
			...seats.map((s, i) => {
				const li = document.createElement("li");
				const b = document.createElement("button");
				b.type = "button";
				b.textContent = `${s.name} (${s.state})`;
				b.addEventListener("click", () =>
					opts.onSeatClick({ id: s.id, name: s.name }),
				);
				b.addEventListener("focus", () => setHover(i));
				b.addEventListener("blur", () => setHover(-1));
				li.appendChild(b);
				return li;
			}),
		);
	}

	/* ----- public api ----- */
	function loadSvg(s: Seat, svg: string): Promise<void> {
		s.svg = svg;
		return svgToImage(svg).then(
			(img) => {
				imgCache.set(s.id, img);
				const i = seats.indexOf(s);
				if (i >= 0 && !disposed) {
					atlas.drawAvatar(i, img, s.name, s.hex);
					wake(800);
				}
			},
			() => undefined,
		);
	}

	const api: TableHandle = {
		kind: "webgl",
		setTheme(theme, scheme) {
			themeName = theme;
			schemeName = scheme;
			applyTheme();
			wake(1500);
		},
		setSeats(list) {
			const now = performance.now();
			seats.length = 0;
			byId.clear();
			for (const init of list.slice(0, MAXS)) {
				const s: Seat = {
					id: init.id,
					name: init.name,
					hex: init.color,
					color: new Color(init.color),
					state: init.state ?? "idle",
					since: (now - t0) / 1000,
					x: 0,
					z: 0,
					cx: 0,
					cz: 0,
					phase: 0,
					ring: 0,
					halo: 0,
					spot: 0,
					mote: 0,
					icon: 0,
					kind: 0,
					hover: 0,
					tint: 1,
				};
				seats.push(s);
				byId.set(s.id, s);
			}
			layout();
			applyTheme();
			syncSr();
			for (const init of list.slice(0, MAXS))
				if (init.avatarSvg) void loadSvg(byId.get(init.id)!, init.avatarSvg);
		},
		setState(id, state) {
			const s = byId.get(id);
			if (!s || s.state === state) return;
			s.state = state;
			s.since = (performance.now() - t0) / 1000;
			animUntil = performance.now() + 2600;
			syncSr();
			wake(1500);
		},
		setAvatar(id, svg) {
			const s = byId.get(id);
			return s ? loadSvg(s, svg) : Promise.resolve();
		},
		setReducedMotion(r) {
			reduced = r;
			if (r) {
				cam.az = tgt.az;
				cam.el = tgt.el;
				cam.zoom = tgt.zoom;
			}
			wake(500);
		},
		resetCamera,
		getStats(): TableStats {
			const avg = frameTimes.length
				? frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length
				: 0;
			const info = renderer.info;
			return {
				kind: "webgl",
				fps: renderStamps.length,
				frameMs: avg,
				frameMsMax: maxMs,
				drawCalls: info.render.calls,
				triangles: info.render.triangles,
				textures: info.memory.textures,
				geometries: info.memory.geometries,
				dpr: renderer.getPixelRatio(),
				lowPower,
				reduced,
				loop: !visible || paused ? "paused" : loop,
				seats: seats.length,
				renders,
			};
		},
		dispose() {
			disposed = true;
			cancelAnimationFrame(rafId);
			ro.disconnect();
			io.disconnect();
			document.removeEventListener("visibilitychange", onVis);
			mqReduced.removeEventListener("change", onMq);
			scene.traverse((o) => {
				const m = o as Mesh;
				m.geometry?.dispose?.();
			});
			for (const m of [
				matFloor,
				matTable,
				matRim,
				matPed,
				matStool,
				matInlay,
				matCandle,
				matCenter,
				matAvatar,
				matLabel,
				matIcon,
				matGlow,
				matShaft,
				matShadow,
			] as Material[])
				m.dispose();
			for (const t of [
				texWood,
				texStone,
				texPlain,
				texGlow,
				texShaft,
				texIcons,
				texRune,
				texRing,
				atlas.tex,
			])
				t.dispose();
			renderer.dispose();
			renderer.forceContextLoss();
			canvasEl.remove();
			sr.remove();
		},
	};

	resize();
	tgt.el = cam.el = defaultElevation();
	fit = fitDistance();
	applyTheme();
	api.setSeats(opts.seats);
	return api;
}
