import { type PerspectiveCamera, Vector3 } from "three";
import type { Hall } from "./hall";
import { type NameSpot, spreadNames } from "./name-layout";
import { PLATE_FONT_STACK } from "./plate";
import type { Podium } from "./podium3d";
import type { SeatState, TableLabels } from "./types";

/**
 * The names over the podiums as page elements, not as part of the picture: a name the person
 * reads has to be at least 12 px on the screen at any distance, in a font that carries Chinese, and
 * a nameplate scaled with the scene is a smudge from across the hall. Each name is a button
 * laid over its podium's nameplate (whichever of the front or back plate faces the camera), so a tap
 * on the name is a tap on the podium and a keyboard can reach every seat.
 */

const PLATE_LOCAL_Y = 1.06;
const PLATE_LOCAL_Z = 0.68;
/** The smallest a name is drawn, in CSS px. */
const MIN_NAME_PX = 12;
const MAX_NAME_PX = 16;

interface Item {
	el: HTMLButtonElement;
	x: number;
	y: number;
	shown: boolean;
}

export class Names {
	readonly root = document.createElement("div");
	private readonly items = new Map<Podium, Item>();
	private readonly point = new Vector3();
	private readonly local = new Vector3();

	constructor(
		container: HTMLElement,
		private readonly labels: TableLabels,
		private readonly click: (podium: Podium) => void,
	) {
		this.root.className = "rt-names";
		container.appendChild(this.root);
	}

	/** The colours of the palette, as the stylesheet reads them. */
	paint(hall: Pick<Hall, "gold" | "goldDark" | "plateInk" | "ink">): void {
		const style = this.root.style;
		style.setProperty("--rt-gold", hall.gold);
		style.setProperty("--rt-gold-dark", hall.goldDark);
		style.setProperty("--rt-plate-ink", hall.plateInk);
		style.setProperty("--rt-ink", hall.ink);
		style.setProperty("--rt-font", PLATE_FONT_STACK);
	}

	/** A name for each podium that stands for a seat or for the agents left out. */
	set(podiums: readonly Podium[], states: (podium: Podium) => SeatState): void {
		for (const item of this.items.values()) item.el.remove();
		this.items.clear();
		for (const podium of podiums) {
			if (podium.init.kind === "owner") continue;
			const el = document.createElement("button");
			el.type = "button";
			el.className = "rt-name";
			el.textContent = podium.init.name;
			el.setAttribute(
				"aria-label",
				podium.init.kind === "agent"
					? this.labels.seat(podium.init.name, states(podium))
					: podium.init.name,
			);
			if (podium.init.id) el.dataset.seat = podium.init.id;
			el.addEventListener("click", () => this.click(podium));
			this.root.appendChild(el);
			this.items.set(podium, { el, x: 0, y: 0, shown: false });
		}
	}

	relabel(podium: Podium, state: SeatState): void {
		const item = this.items.get(podium);
		if (item && podium.init.kind === "agent")
			item.el.setAttribute(
				"aria-label",
				this.labels.seat(podium.init.name, state),
			);
	}

	size(width: number): void {
		this.root.style.setProperty(
			"--rt-name-size",
			`${Math.max(MIN_NAME_PX, Math.min(MAX_NAME_PX, width * 0.0125)).toFixed(1)}px`,
		);
	}

	/**
	 * Lays every name over its plate for the camera as it stands, and keeps the names clear of each
	 * other: a crowded ring makes a name step up or down by a row. A seat the camera is on keeps its
	 * plate's own lettering, which is large there. Returns whether the names stand clear of each other.
	 */
	place(
		camera: PerspectiveCamera,
		eye: Vector3,
		width: number,
		height: number,
		focused: Podium | undefined,
	): boolean {
		camera.updateMatrixWorld();
		const shown: Array<NameSpot & { item: Item }> = [];
		for (const [podium, item] of this.items) {
			this.local.copy(eye);
			podium.group.worldToLocal(this.local);
			const side = this.local.z >= 0 ? 1 : -1;
			this.point.set(0, PLATE_LOCAL_Y, side * PLATE_LOCAL_Z);
			podium.group.localToWorld(this.point);
			this.point.project(camera);
			const x = (this.point.x * 0.5 + 0.5) * width;
			const y = (-this.point.y * 0.5 + 0.5) * height;
			const inside =
				this.point.z < 1 &&
				x > -width * 0.05 &&
				x < width * 1.05 &&
				y > -height * 0.05 &&
				y < height * 1.05;
			const visible =
				inside &&
				podium !== focused &&
				podium.group.visible &&
				!podium.labelHidden;
			if (visible !== item.shown) {
				item.shown = visible;
				item.el.style.visibility = visible ? "visible" : "hidden";
			}
			if (!visible) continue;
			shown.push({
				item,
				x,
				y,
				w: item.el.offsetWidth,
				h: item.el.offsetHeight || MIN_NAME_PX * 1.8,
			});
		}
		const layout = spreadNames(shown, { width, height });
		shown.forEach(({ item }, i) => {
			const spot = layout.spots[i];
			if (!spot) return;
			if (
				Math.abs(spot.x - item.x) > 0.25 ||
				Math.abs(spot.y - item.y) > 0.25
			) {
				item.x = spot.x;
				item.y = spot.y;
				item.el.style.transform = `translate(${spot.x.toFixed(1)}px, ${spot.y.toFixed(1)}px) translate(-50%, -50%)`;
			}
		});
		return layout.clear;
	}

	dispose(): void {
		this.root.remove();
		this.items.clear();
	}
}
