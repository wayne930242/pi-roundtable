import { Vector3 } from "three";
import { blendShot, easeDive, easeInOut } from "./camera";
import { flicker } from "./hall3d";
import { createLoop, type Loop } from "./loop";
import type { Table3DContext } from "./table3d-context";
import { mouthOpenAt } from "./talk";

/** One frame of the hall, the render loop that calls it, and the sizing and visibility that wake it. */
const damp = (v: number, target: number, k: number, dt: number) =>
	v + (target - v) * (1 - Math.exp(-k * dt));

export function frameControls(c: Table3DContext) {
	const {
		container,
		opts,
		onLost,
		renderer,
		canvasEl,
		names,
		scene,
		camera,
		states,
		lowPower,
	} = c;
	let lastClear: boolean | undefined;
	const eye = new Vector3();
	let seconds = 0;
	let frames = 0;
	let cpu = 0;
	let cpuMax = 0;
	let fps = 0;
	let sampleStart = performance.now();

	const frame = (now: number, dt: number): boolean => {
		const t0 = performance.now();
		seconds += dt / 1000;
		let moving = false;
		if (c.stepShow(now)) moving = true;
		if (c.moveMs > 0) {
			const t = (now - c.moveStart) / c.moveMs;
			if (t >= 1) {
				c.shot = c.camTo;
				c.moveMs = 0;
			} else {
				c.shot = blendShot(
					c.camFrom,
					c.camTo,
					c.moveDive ? easeDive(t) : easeInOut(t),
				);
				moving = true;
			}
		} else if (c.dragging) moving = true;
		c.applyCamera();
		camera.getWorldPosition(eye);
		const w = c.world;
		if (w) {
			const at = c.focusId === null ? undefined : w.slotOf.get(c.focusId);
			// the names are laid over where the podiums stand now, not where the last frame drew them
			for (const p of w.podiums) p.group.updateMatrixWorld(true);
			const clear = names.place(
				camera,
				eye,
				container.clientWidth,
				container.clientHeight,
				at === undefined ? undefined : w.podiums[at],
			);
			if (c.focusId === null && clear !== lastClear) {
				lastClear = clear;
				opts.onNames?.(clear);
			}
			flicker(w.built.flames, seconds, c.reduced);
			for (const f of w.built.flames)
				f.body.lookAt(eye.x, f.body.position.y, eye.z);
			for (const p of w.podiums) {
				if (p.init.kind !== "agent") continue;
				const state = states.get(p.init.id ?? "") ?? "idle";
				const speaking = state === "speaking" ? 1 : 0;
				const thinking = state === "thinking" || state === "working" ? 1 : 0;
				const wasSpeak = p.speak;
				p.speak = c.reduced ? speaking : damp(p.speak, speaking, 7, dt / 1000);
				p.bob = c.reduced ? 0 : damp(p.bob, thinking, 5, dt / 1000);
				const lit = p.speak > 0.02;
				p.glow.visible = lit && p.board.visible;
				p.glowMaterial.opacity = 0.85 * p.speak;
				p.board.position.y =
					p.boardY + Math.sin(seconds * 3.1 + p.phase) * 0.035 * p.bob;
				p.face(eye);
				if (p.markFrame(state === "speaking", seconds, c.reduced))
					moving = true;
				// The mouth opens and closes while the seat speaks, and rests closed under reduced motion.
				const talking = state === "speaking" && !c.reduced;
				if (p.mouth(talking && mouthOpenAt(seconds, p.phase)) && talking)
					moving = true;
				if (
					Math.abs(p.speak - speaking) > 0.01 ||
					Math.abs(wasSpeak - p.speak) > 0.001 ||
					p.bob > 0.02
				)
					moving = true;
			}
		}
		renderer.render(scene, camera);
		c.renders += 1;
		frames += 1;
		const spent = performance.now() - t0;
		cpu += spent;
		cpuMax = Math.max(cpuMax, spent);
		if (now - sampleStart >= 1000) {
			fps = (frames * 1000) / (now - sampleStart);
			c.stats = {
				...c.stats,
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
		idleMs: () => (c.reduced ? 0 : lowPower ? 140 : 90),
	});
	c.loop = loop;

	const resize = () => {
		const w = container.clientWidth;
		const h = container.clientHeight;
		if (w <= 0 || h <= 0) return;
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		// the overview stands as far back as the new picture's shape needs
		if (c.focusId === null && !c.dragging && c.world) {
			if (c.moveMs === 0) c.shot = c.targetShot();
			// a turn under way ends on the new picture's overview, not the old one's
			else c.camTo = c.targetShot();
		}
		names.size(w);
		c.loop.wake();
	};
	const observer = new ResizeObserver(resize);
	observer.observe(container);
	const visibility = new IntersectionObserver((entries) => {
		for (const entry of entries) c.loop.setVisible(entry.isIntersecting);
	});
	visibility.observe(container);
	const onVisibility = () => c.loop.sync();
	document.addEventListener("visibilitychange", onVisibility);
	const onContextLost = (event: Event) => {
		event.preventDefault();
		onLost?.();
	};
	canvasEl.addEventListener("webglcontextlost", onContextLost);

	/** Stops watching the container, the document and the canvas. */
	const unbind = () => {
		observer.disconnect();
		visibility.disconnect();
		document.removeEventListener("visibilitychange", onVisibility);
		canvasEl.removeEventListener("webglcontextlost", onContextLost);
	};

	return { frame, resize, loop, unbind };
}
