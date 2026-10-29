import {
	AmbientLight,
	Color,
	DirectionalLight,
	Fog,
	Group,
	PerspectiveCamera,
	Raycaster,
	Scene,
	Vector2,
	Vector3,
	WebGLRenderer,
} from "three";
import {
	blendShot,
	closeupShot,
	dragAngle,
	easeInOut,
	fitFov,
	type Move,
	overviewShot,
	planMove,
	podiumPlace,
	ringRadius,
	type Shot,
	type Slots,
	seatAhead,
	shotVectors,
	slotAngle,
	slotsFor,
	snapAngle,
	startsAtEdge,
	zoomIntent,
} from "./camera";
import { type Hall, hallOf } from "./hall";
import { type Built, buildHall, flicker } from "./hall3d";
import { createLoop, type Loop } from "./loop";
import { Names } from "./names3d";
import { badgeOf, Podium, PodiumKit } from "./podium3d";
import { createSpeedLines, type SpeedLines } from "./speed";
import { mixHex, stickerCanvas } from "./standee";
import { Toon } from "./toon";
import type {
	Scheme,
	SeatInit,
	SeatState,
	TableHandle,
	TableOptions,
	TableStats,
	ThemeName,
} from "./types";
import { ENGLISH_TABLE_LABELS } from "./types";

/** The WebGL council hall: a ring of podiums with standees, seen from the owner's podium or from close to the one who speaks. */

const MAX_DPR = 2;
const PHONE_DPR = 1.5;
/** A swipe in a close-up moves to the next podium after this many px. */
const SWIPE_PX = 60;
/** A pointer that moved less than this many px is a tap. */
const TAP_PX = 8;
/** What a pinch's change of distance has to be before it zooms. */
const PINCH_IN = 1.22;
const PINCH_OUT = 0.82;

const damp = (v: number, target: number, k: number, dt: number) =>
	v + (target - v) * (1 - Math.exp(-k * dt));

interface World {
	hall: Hall;
	toon: Toon;
	kit: PodiumKit;
	built: Built;
	group: Group;
	slots: Slots;
	podiums: Podium[];
	/** Seat id to its slot on the ring. */
	slotOf: Map<string, number>;
	/** The ids in slot order, for the neighbours of a close-up. */
	order: string[];
}

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
	const names = new Names(container, labels, (podium) => {
		if (podium.init.kind === "agent" && podium.init.id)
			opts.onSeatClick({ id: podium.init.id, name: podium.init.name });
		else if (podium.init.kind === "more") opts.onMore?.();
	});
	const speed: SpeedLines = createSpeedLines(container, () => reduced);

	const scene = new Scene();
	const camera = new PerspectiveCamera(42, 1, 0.1, 90);
	const ambient = new AmbientLight();
	const key = new DirectionalLight();
	key.position.set(-6, 12, 7);
	scene.add(ambient, key);

	let theme: ThemeName = opts.theme;
	let scheme: Scheme = opts.scheme;
	let seats: SeatInit[] = [];
	const states = new Map<string, SeatState>();
	const svgs = new Map<string, string>();
	let world: World | undefined;
	let building = 0;

	/* ---------- the camera ---------- */

	let focusId: string | null = null;
	let overviewAz = 0;
	let shot: Shot = overviewShot(0, 1);
	let from: Shot = shot;
	let to: Shot = shot;
	let moveStart = 0;
	let moveMs = 0;
	let dragging: { az: number } | undefined;
	let primed = false;

	const slotsNow = (): Slots => world?.slots ?? slotsFor(seats.length);
	const countNow = () => slotsNow().count;
	const seatAz = (id: string): number | undefined => {
		const slot = world?.slotOf.get(id);
		return slot === undefined ? undefined : slotAngle(slot, countNow());
	};
	const targetShot = (): Shot => {
		const az = focusId ? seatAz(focusId) : undefined;
		return az === undefined
			? overviewShot(overviewAz, countNow())
			: closeupShot(az, countNow());
	};
	const applyCamera = () => {
		const { position, target } = shotVectors(shot);
		camera.position.set(...position);
		camera.lookAt(target[0], target[1], target[2]);
		camera.rotateZ(shot.roll);
		const fov = fitFov(shot.fov, camera.aspect);
		if (Math.abs(camera.fov - fov) > 1e-3) {
			camera.fov = fov;
			camera.updateProjectionMatrix();
		}
	};
	const moveTo = (target: Shot, cut: boolean): Move => {
		const plan = planMove(shot, target, reduced || cut);
		if (plan.cut) {
			shot = target;
			moveMs = 0;
		} else {
			from = shot;
			to = target;
			moveStart = performance.now();
			moveMs = plan.ms;
		}
		loop.wake();
		return plan;
	};

	/* ---------- the world ---------- */

	const disposeWorld = () => {
		if (!world) return;
		scene.remove(world.group);
		for (const p of world.podiums) p.dispose();
		world.kit.dispose();
		world.built.dispose();
		world.toon.dispose();
		world = undefined;
	};

	const stickerOf = async (id: string, expected: number) => {
		const svg = svgs.get(id);
		const w = world;
		if (!svg || !w) return;
		const slot = w.slotOf.get(id);
		const podium = slot === undefined ? undefined : w.podiums[slot];
		if (podium?.init.kind !== "agent") return;
		try {
			const made = await stickerCanvas(svg, 320, {
				rim: w.hall.paper,
				ink: w.hall.ink,
				edge: mixHex(
					seats.find((s) => s.id === id)?.color ?? w.hall.gold,
					w.hall.ink,
					0.35,
				),
			});
			if (expected !== building || world !== w) return;
			podium.setSticker(made.canvas);
			loop.wake();
		} catch {
			/* a picture that does not decode leaves the podium empty, never the scene broken */
		}
	};

	const applyState = (p: Podium, state: SeatState) => {
		p.setBadge(badgeOf(state));
	};

	const build = () => {
		const generation = ++building;
		disposeWorld();
		const hall = hallOf(theme, scheme);
		const slots = slotsFor(seats.length);
		const toon = new Toon();
		toon.setInk(hall.ink);
		const kit = new PodiumKit(hall);
		const built = buildHall(hall, slots.count, toon);
		const group = new Group();
		group.add(built.group);
		const slotOf = new Map<string, number>();
		const order: string[] = [];
		const podiums: Podium[] = [];
		const place = (slot: number, podium: Podium, push = 0) => {
			const at = podiumPlace(slot, slots.count);
			const out = 1 + push / ringRadius(slots.count);
			podium.group.position.set(at.x * out, 0.2, at.z * out);
			podium.group.rotation.y = at.yaw;
			podiums[slot] = podium;
			group.add(podium.group);
		};
		place(
			0,
			new Podium(
				{
					id: undefined,
					name: opts.ownerName ?? "You",
					kind: "owner",
					accent: hall.gold,
				},
				kit,
				toon,
			),
			1.2,
		);
		seats.slice(0, slots.seated).forEach((seat, i) => {
			const slot = i + 1;
			slotOf.set(seat.id, slot);
			order.push(seat.id);
			const podium = new Podium(
				{ id: seat.id, name: seat.name, kind: "agent", accent: seat.color },
				kit,
				toon,
			);
			podium.setDim(seat.dim === true);
			applyState(podium, states.get(seat.id) ?? seat.state ?? "idle");
			place(slot, podium);
		});
		if (slots.more > 0)
			place(
				slots.count - 1,
				new Podium(
					{
						id: undefined,
						name: `+${slots.more}`,
						kind: "more",
						accent: hall.gold,
					},
					kit,
					toon,
				),
			);
		world = { hall, toon, kit, built, group, slots, podiums, slotOf, order };
		scene.add(group);
		group.updateMatrixWorld(true);
		scene.background = new Color(hall.bg);
		scene.fog = new Fog(hall.bg, 17, 46);
		ambient.color.set(hall.ambient);
		ambient.intensity = hall.ambientI;
		key.color.set(hall.key);
		key.intensity = hall.keyI;
		for (const seat of seats.slice(0, slots.seated))
			void stickerOf(seat.id, generation);
		if (focusId && !slotOf.has(focusId)) focusId = null;
		// a new ring has new angles: the camera stays where it stands relative to what it looks at
		moveTo(targetShot(), true);
		names.paint(hall);
		names.set(podiums, (p) => states.get(p.init.id ?? "") ?? "idle");
		loop.wake();
	};

	/* ---------- one frame ---------- */

	/** Whether the names stood clear of each other the last time the whole ring was in view. */
	let lastClear: boolean | undefined;

	const eye = new Vector3();
	let seconds = 0;
	let frames = 0;
	let renders = 0;
	let cpu = 0;
	let cpuMax = 0;
	let fps = 0;
	let sampleStart = performance.now();

	const frame = (now: number, dt: number): boolean => {
		const t0 = performance.now();
		seconds += dt / 1000;
		let moving = false;
		if (moveMs > 0) {
			const t = (now - moveStart) / moveMs;
			if (t >= 1) {
				shot = to;
				moveMs = 0;
			} else {
				shot = blendShot(from, to, easeInOut(t));
				moving = true;
			}
		} else if (dragging) moving = true;
		applyCamera();
		camera.getWorldPosition(eye);
		const w = world;
		if (w) {
			const at = focusId === null ? undefined : w.slotOf.get(focusId);
			const clear = names.place(
				camera,
				eye,
				container.clientWidth,
				container.clientHeight,
				at === undefined ? undefined : w.podiums[at],
			);
			if (focusId === null && clear !== lastClear) {
				lastClear = clear;
				opts.onNames?.(clear);
			}
			flicker(w.built.flames, seconds, reduced);
			for (const f of w.built.flames)
				f.body.lookAt(eye.x, f.body.position.y, eye.z);
			for (const p of w.podiums) {
				if (p.init.kind !== "agent") continue;
				const state = states.get(p.init.id ?? "") ?? "idle";
				const speaking = state === "speaking" ? 1 : 0;
				const thinking = state === "thinking" || state === "working" ? 1 : 0;
				const wasSpeak = p.speak;
				p.speak = reduced ? speaking : damp(p.speak, speaking, 7, dt / 1000);
				p.bob = reduced ? 0 : damp(p.bob, thinking, 5, dt / 1000);
				const lit = p.speak > 0.02;
				p.glow.visible = lit && p.board.visible;
				p.glowMaterial.opacity = 0.85 * p.speak;
				p.board.position.y =
					p.boardY + Math.sin(seconds * 3.1 + p.phase) * 0.035 * p.bob;
				p.face(eye);
				if (p.markFrame(state === "speaking", seconds, reduced)) moving = true;
				if (
					Math.abs(p.speak - speaking) > 0.01 ||
					Math.abs(wasSpeak - p.speak) > 0.001 ||
					p.bob > 0.02
				)
					moving = true;
			}
		}
		renderer.render(scene, camera);
		renders += 1;
		frames += 1;
		const spent = performance.now() - t0;
		cpu += spent;
		cpuMax = Math.max(cpuMax, spent);
		if (now - sampleStart >= 1000) {
			fps = (frames * 1000) / (now - sampleStart);
			stats = {
				...stats,
				fps,
				frameMs: cpu / Math.max(frames, 1),
				frameMsMax: cpuMax,
			};
			frames = 0;
			cpu = 0;
			cpuMax = 0;
			sampleStart = now;
		}
		return moving;
	};

	const loop: Loop = createLoop({
		frame,
		host: {
			request: (run) => requestAnimationFrame(run),
			cancel: (handle) => cancelAnimationFrame(handle),
			hidden: () => document.hidden,
		},
		idleMs: () => (reduced ? 0 : lowPower ? 140 : 90),
	});

	let stats: TableStats = {
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
		reduced,
		loop: "idle",
		seats: 0,
		renders: 0,
	};

	/* ---------- sizing, visibility ---------- */

	const resize = () => {
		const w = container.clientWidth;
		const h = container.clientHeight;
		if (w <= 0 || h <= 0) return;
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		names.size(w);
		loop.wake();
	};
	const observer = new ResizeObserver(resize);
	observer.observe(container);
	const visibility = new IntersectionObserver((entries) => {
		for (const entry of entries) loop.setVisible(entry.isIntersecting);
	});
	visibility.observe(container);
	const onVisibility = () => loop.sync();
	document.addEventListener("visibilitychange", onVisibility);
	const onContextLost = (event: Event) => {
		event.preventDefault();
		onLost?.();
	};
	canvasEl.addEventListener("webglcontextlost", onContextLost);

	/* ---------- focus ---------- */

	const setFocus = (id: string | null, cut: boolean, fromPerson: boolean) => {
		const wanted = id !== null && world?.slotOf.has(id) ? id : null;
		if (wanted === focusId) return;
		focusId = wanted;
		const plan = moveTo(targetShot(), cut);
		if (wanted !== null && primed && !plan.cut) speed.play();
		if (fromPerson) opts.onFocus?.(wanted);
	};

	/* ---------- the person's hands ---------- */

	const pointer = new Vector2();
	const ray = new Raycaster();
	const hit = (clientX: number, clientY: number) => {
		const w = world;
		if (!w) return undefined;
		const rect = canvasEl.getBoundingClientRect();
		pointer.set(
			((clientX - rect.left) / rect.width) * 2 - 1,
			-((clientY - rect.top) / rect.height) * 2 + 1,
		);
		ray.setFromCamera(pointer, camera);
		const found = ray.intersectObjects(
			w.podiums.flatMap((p) => p.hits).filter((m) => m.visible),
			false,
		)[0];
		return found?.object.userData as
			| { seat: string | null; kind: string }
			| undefined;
	};

	const touches = new Map<number, { x: number; y: number }>();
	let press: { x: number; y: number; az: number; ok: boolean } | undefined;
	let pinchFrom = 0;
	let pinched = false;
	const spread = () => {
		const [a, b] = [...touches.values()];
		return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
	};

	const onDown = (event: PointerEvent) => {
		touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
		if (touches.size === 2) {
			pinchFrom = spread();
			pinched = false;
			press = undefined;
			dragging = undefined;
			return;
		}
		const rect = canvasEl.getBoundingClientRect();
		const ok = !startsAtEdge(event.clientX, event.clientY, rect, {
			width: innerWidth,
			height: innerHeight,
		});
		press = { x: event.clientX, y: event.clientY, az: overviewAz, ok };
		if (ok) canvasEl.setPointerCapture?.(event.pointerId);
		canvasEl.style.cursor = "grabbing";
	};
	const onMove = (event: PointerEvent) => {
		if (touches.has(event.pointerId))
			touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
		if (touches.size === 2 && pinchFrom > 0 && !pinched) {
			const ratio = spread() / pinchFrom;
			const intent =
				ratio > PINCH_IN ? "in" : ratio < PINCH_OUT ? "out" : "none";
			if (intent !== "none") {
				pinched = true;
				zoom(intent === "in" ? -1 : 1);
			}
			return;
		}
		if (!press) {
			if (event.buttons === 0)
				canvasEl.style.cursor = hit(event.clientX, event.clientY)
					? "pointer"
					: "grab";
			return;
		}
		if (!press.ok || focusId !== null) return;
		const dx = event.clientX - press.x;
		if (Math.abs(dx) < TAP_PX && !dragging) return;
		const az = press.az + dragAngle(dx, canvasEl.clientWidth);
		dragging = { az };
		shot = overviewShot(az, countNow());
		moveMs = 0;
		loop.wake();
	};
	const onUp = (event: PointerEvent) => {
		touches.delete(event.pointerId);
		if (touches.size < 2) pinchFrom = 0;
		canvasEl.style.cursor = "grab";
		const start = press;
		press = undefined;
		if (!start || pinched) {
			if (touches.size === 0) pinched = false;
			return;
		}
		const dx = event.clientX - start.x;
		const dy = event.clientY - start.y;
		if (dragging) {
			// let go: settle on the nearest podium's place on the ring
			overviewAz = snapAngle(dragging.az, countNow());
			dragging = undefined;
			moveTo(overviewShot(overviewAz, countNow()), false);
			return;
		}
		if (Math.hypot(dx, dy) < TAP_PX) {
			const found = hit(event.clientX, event.clientY);
			if (!found) return;
			if (found.kind === "agent" && found.seat) {
				const seat = seats.find((s) => s.id === found.seat);
				if (seat) opts.onSeatClick({ id: seat.id, name: seat.name });
			} else if (found.kind === "more") opts.onMore?.();
			else if (found.kind === "owner" && focusId !== null)
				setFocus(null, false, true);
			return;
		}
		if (
			start.ok &&
			focusId !== null &&
			Math.abs(dx) >= SWIPE_PX &&
			Math.abs(dx) > Math.abs(dy)
		)
			step(dx < 0 ? 1 : -1);
	};
	const onCancel = (event: PointerEvent) => {
		touches.delete(event.pointerId);
		press = undefined;
		if (dragging) {
			overviewAz = snapAngle(dragging.az, countNow());
			dragging = undefined;
			moveTo(overviewShot(overviewAz, countNow()), false);
		}
		canvasEl.style.cursor = "grab";
	};

	/** Moves a close-up to the next (+1) or previous (-1) agent round the ring. */
	const step = (direction: 1 | -1) => {
		const w = world;
		if (!w || focusId === null || w.order.length < 2) return;
		const at = w.order.indexOf(focusId);
		const next = w.order[(at + direction + w.order.length) % w.order.length];
		if (next) setFocus(next, false, true);
	};

	/** A wheel turn or a pinch: closer to the podium across the ring, or back out to the whole ring. */
	const zoom = (delta: number) => {
		const w = world;
		if (!w) return;
		const intent = zoomIntent(delta, focusId !== null);
		if (intent === "in") {
			const slot = seatAhead(overviewAz, w.slots);
			const id = slot === undefined ? undefined : w.order[slot - 1];
			if (id) setFocus(id, false, true);
		} else if (intent === "out") setFocus(null, false, true);
	};
	let wheelAt = 0;
	const onWheel = (event: WheelEvent) => {
		event.preventDefault();
		const now = performance.now();
		if (now - wheelAt < 450 || Math.abs(event.deltaY) < 4) return;
		wheelAt = now;
		zoom(event.deltaY);
	};

	canvasEl.addEventListener("pointerdown", onDown);
	canvasEl.addEventListener("pointermove", onMove);
	canvasEl.addEventListener("pointerup", onUp);
	canvasEl.addEventListener("pointercancel", onCancel);
	canvasEl.addEventListener("wheel", onWheel, { passive: false });

	/* ---------- the handle ---------- */

	const sameRing = (next: SeatInit[]) =>
		next.length === seats.length &&
		next.every(
			(s, i) =>
				s.id === seats[i]?.id &&
				s.name === seats[i]?.name &&
				s.color === seats[i]?.color,
		);

	seats = opts.seats.map((s) => ({ ...s }));
	for (const s of seats) {
		if (s.state) states.set(s.id, s.state);
		if (s.avatarSvg) svgs.set(s.id, s.avatarSvg);
	}
	if (opts.focus && seats.some((s) => s.id === opts.focus))
		focusId = opts.focus;
	build();
	shot = targetShot();
	resize();
	primed = true;

	return {
		kind: "webgl",
		setTheme(nextTheme, nextScheme) {
			if (nextTheme === theme && nextScheme === scheme) return;
			theme = nextTheme;
			scheme = nextScheme;
			build();
		},
		setSeats(next) {
			const rebuild = !sameRing(next);
			seats = next.map((s) => ({ ...s }));
			for (const s of seats) {
				if (s.state) states.set(s.id, s.state);
				if (s.avatarSvg && s.avatarSvg !== svgs.get(s.id))
					svgs.set(s.id, s.avatarSvg);
			}
			if (rebuild) build();
			else {
				const w = world;
				for (const s of seats) {
					const slot = w?.slotOf.get(s.id);
					const p = slot === undefined ? undefined : w?.podiums[slot];
					p?.setDim(s.dim === true);
					void stickerOf(s.id, building);
				}
			}
			loop.wake();
		},
		setState(id, state) {
			states.set(id, state);
			const slot = world?.slotOf.get(id);
			const p = slot === undefined ? undefined : world?.podiums[slot];
			if (p) {
				applyState(p, state);
				names.relabel(p, state);
			}
			loop.wake();
		},
		async setAvatar(id, svg) {
			svgs.set(id, svg);
			await stickerOf(id, building);
		},
		setReducedMotion(next) {
			reduced = next;
			stats.reduced = next;
			if (next) moveTo(targetShot(), true);
			loop.wake();
		},
		resetCamera() {
			overviewAz = 0;
			setFocus(null, false, true);
			moveTo(targetShot(), false);
		},
		focus(id, options) {
			setFocus(id, options?.cut === true, false);
		},
		focused: () => focusId,
		getStats() {
			const info = renderer.info;
			return {
				...stats,
				drawCalls: info.render.calls,
				triangles: info.render.triangles,
				textures: info.memory.textures,
				geometries: info.memory.geometries,
				loop: loop.state,
				seats: seats.length,
				renders,
				reduced,
			};
		},
		dispose() {
			loop.dispose();
			observer.disconnect();
			visibility.disconnect();
			document.removeEventListener("visibilitychange", onVisibility);
			canvasEl.removeEventListener("webglcontextlost", onContextLost);
			canvasEl.removeEventListener("pointerdown", onDown);
			canvasEl.removeEventListener("pointermove", onMove);
			canvasEl.removeEventListener("pointerup", onUp);
			canvasEl.removeEventListener("pointercancel", onCancel);
			canvasEl.removeEventListener("wheel", onWheel);
			speed.dispose();
			names.dispose();
			disposeWorld();
			renderer.dispose();
			renderer.forceContextLoss();
			canvasEl.remove();
		},
	};
}
