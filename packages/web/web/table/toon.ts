import {
	BackSide,
	type BufferGeometry,
	Color,
	DataTexture,
	Mesh,
	MeshBasicMaterial,
	MeshToonMaterial,
	NearestFilter,
	RedFormat,
	UnsignedByteType,
	Vector3,
} from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * The scene's one look in three: flat colour with two or three tones of shade (a stepped gradient on
 * a toon material) and a dark outline round every solid shape (an inverted hull, a copy of the shape
 * pushed out along its smoothed normals and drawn from the inside).
 */

/** A gradient of three steps; shade falls on the lowest, light on the highest. */
export function toneSteps(): DataTexture {
	const data = new Uint8Array([88, 170, 255]);
	const tex = new DataTexture(data, 3, 1, RedFormat, UnsignedByteType);
	tex.minFilter = NearestFilter;
	tex.magFilter = NearestFilter;
	tex.generateMipmaps = false;
	tex.needsUpdate = true;
	return tex;
}

/** Makes and caches the materials a scene needs, so a palette change recolours them in place. */
export class Toon {
	readonly steps = toneSteps();
	private readonly lit = new Map<string, MeshToonMaterial>();
	private readonly flat = new Map<string, MeshBasicMaterial>();
	ink = new Color("#000000");
	readonly hullMaterial = new MeshBasicMaterial({
		color: this.ink,
		side: BackSide,
		fog: false,
	});

	/** A toon material that keeps its slot while its colour follows the palette: `set(key, color)` again to recolour. */
	toon(key: string, color: string): MeshToonMaterial {
		let m = this.lit.get(key);
		if (!m) {
			m = new MeshToonMaterial({ color, gradientMap: this.steps });
			this.lit.set(key, m);
		} else m.color.set(color);
		return m;
	}

	basic(key: string, color: string): MeshBasicMaterial {
		let m = this.flat.get(key);
		if (!m) {
			m = new MeshBasicMaterial({ color, fog: false });
			this.flat.set(key, m);
		} else m.color.set(color);
		return m;
	}

	setInk(color: string): void {
		this.ink.set(color);
		this.hullMaterial.color.copy(this.ink);
	}

	dispose(): void {
		this.steps.dispose();
		this.hullMaterial.dispose();
		for (const m of this.lit.values()) m.dispose();
		for (const m of this.flat.values()) m.dispose();
	}
}

/** The copy of a shape that draws its outline: smoothed normals so the corners of a box grow evenly, then pushed out by `width`. */
export function hullGeometry(
	source: BufferGeometry,
	width: number,
): BufferGeometry {
	const hull = source.clone();
	hull.deleteAttribute("uv");
	hull.deleteAttribute("normal");
	const merged = mergeVertices(hull, 1e-4);
	merged.computeVertexNormals();
	const position = merged.getAttribute("position");
	const normal = merged.getAttribute("normal");
	const out = new Vector3();
	for (let i = 0; i < position.count; i += 1) {
		out.fromBufferAttribute(normal, i).multiplyScalar(width);
		position.setXYZ(
			i,
			position.getX(i) + out.x,
			position.getY(i) + out.y,
			position.getZ(i) + out.z,
		);
	}
	position.needsUpdate = true;
	return merged;
}

/** A mesh with its outline as a child that shares its transform. */
export function outlined(
	mesh: Mesh,
	toon: Toon,
	width: number,
	hulls: Map<BufferGeometry, BufferGeometry>,
): Mesh {
	let hull = hulls.get(mesh.geometry);
	if (!hull) {
		hull = hullGeometry(mesh.geometry, width);
		hulls.set(mesh.geometry, hull);
	}
	const shell = new Mesh(hull, toon.hullMaterial);
	shell.renderOrder = mesh.renderOrder;
	shell.userData.hull = true;
	mesh.add(shell);
	return mesh;
}
