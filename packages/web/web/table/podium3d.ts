import {
	AdditiveBlending,
	BoxGeometry,
	type BufferGeometry,
	CanvasTexture,
	ClampToEdgeWrapping,
	CylinderGeometry,
	Group,
	LinearFilter,
	Mesh,
	MeshBasicMaterial,
	MeshToonMaterial,
	NormalBlending,
	PlaneGeometry,
	SRGBColorSpace,
	type Texture,
	type Vector3,
} from "three";
import { badgeCanvas, canvas, glowCanvas, panelCanvas } from "./decals";
import type { Hall } from "./hall";
import { drawPlate } from "./plate";
import { outlined, type Toon } from "./toon";
import type { SeatState } from "./types";

/**
 * A podium and what stands on it: a tall dark-wood desk with a gold nameplate on its front and back,
 * and a standee board that peeks over it. The podium's front looks toward the centre of the hall (+z
 * in its own frame); the standee turns on its own to face the camera, within limits.
 */

/** How far a standee may turn from facing the centre to face the camera, radians. */
export const STANDEE_TURN = 0.62;
const BOARD_W = 1.9;
const BOARD_Y = 1.98;
const PLATE_W = 1.24;
const PLATE_H = 0.31;
const PLATE_PX = [512, 128] as const;

/** The signs over a standee, by the cell of the badge atlas they come from. */
export type Badge = "waiting" | "alert" | "done" | "error";
const BADGE_CELL: Record<Badge, number> = {
	waiting: 0,
	alert: 1,
	done: 2,
	error: 3,
};

/** Which sign a state shows over the standee, if any. */
export function badgeOf(state: SeatState): Badge | null {
	switch (state) {
		case "thinking":
		case "working":
			return "waiting";
		case "waiting":
			return "alert";
		case "done":
			return "done";
		case "error":
			return "error";
		default:
			return null;
	}
}

/** The geometries and textures every podium of a scene shares. */
export class PodiumKit {
	readonly geometries: BufferGeometry[] = [];
	readonly textures: Texture[] = [];
	readonly hulls = new Map<BufferGeometry, BufferGeometry>();
	readonly plinth = this.own(new BoxGeometry(1.84, 0.2, 1.4));
	readonly body: CylinderGeometry;
	readonly slab = this.own(new BoxGeometry(1.98, 0.14, 1.5));
	readonly trim = this.own(new BoxGeometry(2.01, 0.04, 1.53));
	readonly panelPlane = this.own(new PlaneGeometry(0.84, 1.05));
	readonly platePlane = this.own(new PlaneGeometry(PLATE_W, PLATE_H));
	readonly glowPlane = this.own(new PlaneGeometry(3.3, 3.3));
	readonly badgePlanes: Record<Badge, PlaneGeometry>;
	readonly panelTexture: CanvasTexture;
	readonly glowTexture: CanvasTexture;
	readonly badgeTexture: CanvasTexture;

	constructor(readonly hall: Hall) {
		const frustum = new CylinderGeometry(
			0.82 * Math.SQRT2,
			0.72 * Math.SQRT2,
			1,
			4,
			1,
		);
		frustum.rotateY(Math.PI / 4);
		this.body = this.own(frustum);
		this.panelTexture = this.texture(panelCanvas(hall));
		this.glowTexture = this.texture(glowCanvas());
		this.badgeTexture = this.texture(badgeCanvas(hall));
		const cell = (n: number) => {
			const g = new PlaneGeometry(0.56, 0.56);
			const uv = g.getAttribute("uv");
			for (let i = 0; i < uv.count; i += 1) uv.setX(i, (n + uv.getX(i)) / 4);
			return this.own(g);
		};
		this.badgePlanes = {
			waiting: cell(BADGE_CELL.waiting),
			alert: cell(BADGE_CELL.alert),
			done: cell(BADGE_CELL.done),
			error: cell(BADGE_CELL.error),
		};
	}

	private own<T extends BufferGeometry>(g: T): T {
		this.geometries.push(g);
		return g;
	}

	texture(c: HTMLCanvasElement): CanvasTexture {
		const t = new CanvasTexture(c);
		t.colorSpace = SRGBColorSpace;
		t.wrapS = ClampToEdgeWrapping;
		t.wrapT = ClampToEdgeWrapping;
		t.anisotropy = 4;
		t.minFilter = LinearFilter;
		this.textures.push(t);
		return t;
	}

	dispose(): void {
		for (const g of this.geometries) g.dispose();
		for (const g of this.hulls.values()) g.dispose();
		for (const t of this.textures) t.dispose();
	}
}

export interface PodiumInit {
	/** The id a click reports; absent for the owner's podium. */
	id: string | undefined;
	name: string;
	/** An agent's podium carries a standee; the owner's is the camera's home, and "+N" opens the list of the agents left out. */
	kind: "agent" | "owner" | "more";
	/** The seat's accent, which tints the speaking light. */
	accent: string;
}

/** One podium on the ring, with the pieces the scene moves. */
export class Podium {
	readonly group = new Group();
	readonly rig = new Group();
	readonly board: Mesh;
	readonly boardMaterial: MeshBasicMaterial;
	readonly glow: Mesh;
	readonly glowMaterial: MeshBasicMaterial;
	readonly badge: Mesh;
	readonly badgeMaterial: MeshBasicMaterial;
	readonly hits: Mesh[] = [];
	private readonly plateTexture: CanvasTexture;
	private readonly plateMaterial: MeshBasicMaterial;
	private readonly panelMaterial: MeshToonMaterial;
	private shown: Badge | null = null;
	/** The nameplate's text as drawn, and its size in canvas px, for the readability check. */
	plateText = { text: "", px: 0 };
	/** 0 to 1 channels the loop eases. */
	speak = 0;
	bob = 0;
	/** Where the board rests, before the bob. */
	boardY = 0;
	phase = Math.random() * 6;

	constructor(
		readonly init: PodiumInit,
		private readonly kit: PodiumKit,
		toon: Toon,
	) {
		const { hall } = kit;
		const hit = (m: Mesh) => {
			m.userData.seat = init.id ?? null;
			m.userData.kind = init.kind;
			this.hits.push(m);
			return m;
		};
		const plinth = new Mesh(kit.plinth, toon.toon("woodDark", hall.woodDark));
		plinth.position.y = 0.1;
		outlined(plinth, toon, 0.045, kit.hulls);
		const body = new Mesh(kit.body, toon.toon("wood", hall.wood));
		body.scale.set(1, 1, 0.756);
		body.position.y = 0.7;
		outlined(body, toon, 0.045, kit.hulls);
		const slab = new Mesh(kit.slab, toon.toon("woodLight", hall.woodLight));
		slab.position.y = 1.27;
		outlined(slab, toon, 0.045, kit.hulls);
		const trim = new Mesh(kit.trim, toon.toon("gold", hall.gold));
		trim.position.y = 1.2;
		this.group.add(plinth, hit(body), hit(slab), trim);

		this.panelMaterial = new MeshToonMaterial({
			map: kit.panelTexture,
			transparent: true,
			gradientMap: toon.steps,
		});
		const panel = new Mesh(kit.panelPlane, this.panelMaterial);
		panel.position.set(0, 0.68, 0.64);
		this.group.add(panel);

		const [pw, ph] = PLATE_PX;
		const [plate, g] = canvas(pw, ph);
		this.plateTexture = kit.texture(plate);
		this.plateText = drawPlate(g, init.name, pw, ph, hall);
		this.plateMaterial = new MeshBasicMaterial({
			map: this.plateTexture,
			fog: false,
		});
		const front = new Mesh(kit.platePlane, this.plateMaterial);
		front.position.set(0, 1.06, 0.68);
		front.rotation.x = -0.16;
		const back = new Mesh(kit.platePlane, this.plateMaterial);
		back.position.set(0, 1.06, -0.68);
		back.rotation.y = Math.PI;
		back.rotation.x = -0.16;
		this.group.add(hit(front), hit(back));

		const boardMaterial = new MeshBasicMaterial({
			transparent: true,
			alphaTest: 0.4,
			fog: false,
		});
		this.boardMaterial = boardMaterial;
		this.board = new Mesh(new PlaneGeometry(BOARD_W, BOARD_W), boardMaterial);
		this.board.visible = false;
		this.board.position.y = BOARD_Y - 0.35;
		hit(this.board);
		this.glowMaterial = new MeshBasicMaterial({
			map: kit.glowTexture,
			color: init.accent,
			transparent: true,
			opacity: 0,
			depthWrite: false,
			fog: false,
			blending: hall.additive ? AdditiveBlending : NormalBlending,
		});
		this.glow = new Mesh(kit.glowPlane, this.glowMaterial);
		this.glow.position.set(0, BOARD_Y - 0.1, -0.5);
		this.glow.visible = false;
		this.badgeMaterial = new MeshBasicMaterial({
			map: kit.badgeTexture,
			transparent: true,
			alphaTest: 0.2,
			fog: false,
		});
		this.badge = new Mesh(kit.badgePlanes.waiting, this.badgeMaterial);
		this.badge.position.set(0.78, BOARD_Y + 0.62, 0.05);
		this.badge.visible = false;
		this.badge.renderOrder = 5;
		if (init.kind === "agent") {
			this.rig.position.set(0, 0, -0.35);
			this.rig.add(this.glow, this.board, this.badge);
			this.group.add(this.rig);
		}
	}

	/** Sets the board's picture and sizes it to the picture's proportions. */
	setSticker(canvasEl: HTMLCanvasElement): void {
		const old = this.boardMaterial.map;
		const map = this.kit.texture(canvasEl);
		this.boardMaterial.map = map;
		this.boardMaterial.needsUpdate = true;
		const ratio = canvasEl.height / canvasEl.width;
		this.board.scale.set(1, ratio, 1);
		this.boardY = 1.2 + (BOARD_W * ratio) / 2 - 0.12;
		this.board.position.y = this.boardY;
		this.glow.position.y = this.boardY;
		this.badge.position.y =
			this.board.position.y + (BOARD_W * ratio) / 2 + 0.02;
		this.board.visible = true;
		old?.dispose();
	}

	setBadge(badge: Badge | null): void {
		if (badge === this.shown) return;
		this.shown = badge;
		this.badge.visible = badge !== null;
		if (badge) this.badge.geometry = this.kit.badgePlanes[badge];
	}

	setDim(dim: boolean): void {
		this.boardMaterial.color.set(dim ? "#7a7f8f" : "#ffffff");
	}

	/** Turns the standee toward the camera, but never far from facing the centre of the hall. */
	face(camera: Vector3): void {
		const local = this.rig.worldToLocal(camera.clone());
		const angle = Math.atan2(local.x, local.z);
		this.rig.rotation.y = Math.max(
			-STANDEE_TURN,
			Math.min(STANDEE_TURN, angle),
		);
	}

	dispose(): void {
		this.plateTexture.dispose();
		this.plateMaterial.dispose();
		this.panelMaterial.dispose();
		this.boardMaterial.map?.dispose();
		this.boardMaterial.dispose();
		this.board.geometry.dispose();
		this.glowMaterial.dispose();
		this.badgeMaterial.dispose();
	}
}
