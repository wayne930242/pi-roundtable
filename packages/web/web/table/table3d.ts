import {
	AmbientLight,
	DirectionalLight,
	PerspectiveCamera,
	Scene,
	WebGLRenderer,
} from "three";
import { overviewShot, type Shot } from "./camera";
import { Names } from "./names3d";
import { planSeating } from "./seating";
import { createSpeedLines, type SpeedLines } from "./speed";
import { cameraControls } from "./table3d-camera";
import type { Table3DContext } from "./table3d-context";
import { frameControls } from "./table3d-frame";
import { inputControls } from "./table3d-input";
import { showControls } from "./table3d-show";
import { worldBuilder } from "./table3d-world";
import type { SeatInit, SeatState, TableHandle, TableOptions } from "./types";
import { ENGLISH_TABLE_LABELS } from "./types";

/** The WebGL council hall: a ring of podiums with standees, seen from the owner's podium or from close to the one who speaks. */
const MAX_DPR = 2;
const PHONE_DPR = 1.5;

export function createTable3D(
	container: HTMLElement,
	opts: TableOptions,
	onLost?: () => void,
): TableHandle {
	const mqReduced = window.matchMedia("(prefers-reduced-motion: reduce)");
	const reducedNow =
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
	const dprCap = lowPower ? PHONE_DPR : MAX_DPR;

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
	const labels = opts.labels ?? ENGLISH_TABLE_LABELS;
	const names = new Names(container, labels, (podium, at) => {
		if (podium.init.kind === "agent" && podium.init.id)
			opts.onSeatClick({ id: podium.init.id, name: podium.init.name, at });
	});
	const speed: SpeedLines = createSpeedLines(container, () => c.reduced);

	const scene = new Scene();
	const camera = new PerspectiveCamera(42, 1, 0.1, 90);
	const ambient = new AmbientLight();
	const key = new DirectionalLight();
	key.position.set(-6, 12, 7);
	scene.add(ambient, key);

	const shot: Shot = overviewShot(0, 1);
	const c = {
		container,
		opts,
		onLost,
		renderer,
		canvasEl,
		names,
		speed,
		scene,
		camera,
		ambient,
		key,
		lowPower,
		states: new Map<string, SeatState>(),
		marks: new Map<string, string>(),
		svgs: new Map<string, string>(),
		talks: new Map<string, string>(),
		reduced: reducedNow,
		theme: opts.theme,
		scheme: opts.scheme,
		seats: [] as SeatInit[],
		world: undefined,
		building: 0,
		show: undefined,
		focusId: null,
		overviewAz: 0,
		shot,
		camFrom: shot,
		camTo: shot,
		moveStart: 0,
		moveMs: 0,
		moveDive: false,
		dragging: undefined,
		primed: false,
		renders: 0,
		stats: {
			kind: "webgl",
			fps: 0,
			frameMs: 0,
			frameMsMax: 0,
			drawCalls: 0,
			triangles: 0,
			textures: 0,
			geometries: 0,
			dpr: renderer.getPixelRatio(),
			lowPower,
			reduced: reducedNow,
			loop: "idle",
			seats: 0,
			renders: 0,
		},
	} as unknown as Table3DContext;
	const frame = frameControls(c);
	const input = inputControls(c);
	Object.assign(
		c,
		cameraControls(c),
		worldBuilder(c),
		showControls(c),
		input,
		frame,
	);
	input.attach();

	const { states, marks, svgs, talks } = c;

	const sameRing = (next: SeatInit[]) =>
		next.length === c.seats.length &&
		next.every(
			(s, i) =>
				s.id === c.seats[i]?.id &&
				s.name === c.seats[i]?.name &&
				s.color === c.seats[i]?.color,
		);

	c.seats = opts.seats.map((s) => ({ ...s }));
	for (const s of c.seats) {
		if (s.state) states.set(s.id, s.state);
		if (s.avatarSvg) svgs.set(s.id, s.avatarSvg);
		if (s.talkSvg) talks.set(s.id, s.talkSvg);
	}
	if (opts.focus && c.seats.some((s) => s.id === opts.focus))
		c.focusId = opts.focus;
	c.build();
	c.shot = c.targetShot();
	c.resize();
	c.primed = true;

	return {
		kind: "webgl",
		setTheme(nextTheme, nextScheme) {
			if (nextTheme === c.theme && nextScheme === c.scheme) return;
			c.endShow();
			c.theme = nextTheme;
			c.scheme = nextScheme;
			c.build();
		},
		setSeats(next) {
			c.endShow();
			const rebuild = !sameRing(next);
			const copy = next.map((s) => ({ ...s }));
			const plan =
				rebuild && c.primed && c.world
					? planSeating(c.shownIds(c.seats), c.shownIds(copy), c.reduced)
					: undefined;
			for (const s of copy) {
				if (s.state) states.set(s.id, s.state);
				if (s.avatarSvg && s.avatarSvg !== svgs.get(s.id))
					svgs.set(s.id, s.avatarSvg);
				if (s.avatarSvg) {
					if (s.talkSvg) talks.set(s.id, s.talkSvg);
					else talks.delete(s.id);
				}
			}
			// the seats that come and go play out; the old ring stands until they have
			if (plan && plan.mode !== "cut") {
				c.startShow(copy, plan);
				return;
			}
			c.seats = copy;
			if (rebuild) c.build();
			else {
				const w = c.world;
				for (const s of c.seats) {
					const slot = w?.slotOf.get(s.id);
					const p = slot === undefined ? undefined : w?.podiums[slot];
					p?.setDim(s.dim === true);
					void c.stickerOf(s.id, c.building);
				}
			}
			c.loop.wake();
		},
		setState(id, state) {
			states.set(id, state);
			const slot = c.world?.slotOf.get(id);
			const p = slot === undefined ? undefined : c.world?.podiums[slot];
			if (p) {
				c.applyState(p, state);
				names.relabel(p, state);
			}
			c.loop.wake();
		},
		setMark(id, mark) {
			if (mark === null) marks.delete(id);
			else marks.set(id, mark);
			const slot = c.world?.slotOf.get(id);
			const p = slot === undefined ? undefined : c.world?.podiums[slot];
			if (p) names.mark(p, mark);
			c.loop.wake();
		},
		async setAvatar(id, svg, talk) {
			svgs.set(id, svg);
			if (talk) talks.set(id, talk);
			else talks.delete(id);
			await c.stickerOf(id, c.building);
		},
		setReducedMotion(next) {
			c.reduced = next;
			c.stats.reduced = next;
			if (next) c.moveTo(c.targetShot(), true);
			c.loop.wake();
		},
		resetCamera() {
			c.overviewAz = 0;
			c.setFocus(null, false, true);
			c.moveTo(c.targetShot(), false);
		},
		focus(id, options) {
			c.setFocus(id, options?.cut === true, false);
		},
		focused: () => c.focusId,
		seatAt(x, y) {
			const found = c.hit(x, y);
			return found?.kind === "agent" ? found.seat : null;
		},
		getStats() {
			const info = renderer.info;
			return {
				...c.stats,
				drawCalls: info.render.calls,
				triangles: info.render.triangles,
				textures: info.memory.textures,
				geometries: info.memory.geometries,
				loop: c.loop.state,
				seats: c.seats.length,
				renders: c.renders,
				reduced: c.reduced,
			};
		},
		dispose() {
			if (c.show) {
				for (const t of c.show.timers) clearTimeout(t);
				c.show.fx?.dispose();
				c.show = undefined;
			}
			c.loop.dispose();
			frame.unbind();
			input.detach();
			speed.dispose();
			names.dispose();
			c.disposeWorld();
			renderer.dispose();
			renderer.forceContextLoss();
			canvasEl.remove();
		},
	};
}
