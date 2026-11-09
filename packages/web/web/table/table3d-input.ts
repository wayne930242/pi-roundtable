import { Raycaster, Vector2 } from "three";
import { HOLD_MS } from "../lib/long-press.ts";
import {
	dragAngle,
	overviewShot,
	snapAngle,
	startsAtEdge,
	swipeStep,
} from "./camera";
import type { Table3DContext } from "./table3d-context";

/** The person's hands on the canvas: a press and drag, a tap, a swipe, a pinch and the wheel. */
/** A swipe in a close-up moves to the next podium after this many px. */
const SWIPE_PX = 60;
/** A pointer that moved less than this many px is a tap. */
const TAP_PX = 8;
/** What a pinch's change of distance has to be before it zooms. */
const PINCH_IN = 1.22;
const PINCH_OUT = 0.82;

export function inputControls(c: Table3DContext) {
	const { opts, canvasEl, camera } = c;
	const pointer = new Vector2();
	const ray = new Raycaster();
	const hit = (clientX: number, clientY: number) => {
		const w = c.world;
		if (!w) return undefined;
		const rect = canvasEl.getBoundingClientRect();
		pointer.set(
			((clientX - rect.left) / rect.width) * 2 - 1,
			-((clientY - rect.top) / rect.height) * 2 + 1,
		);
		ray.setFromCamera(pointer, camera);
		const found = ray.intersectObjects(
			w.podiums
				.filter((p) => p.group.visible)
				.flatMap((p) => p.hits)
				.filter((m) => m.visible),
			false,
		)[0];
		return found?.object.userData as
			| { seat: string | null; kind: string }
			| undefined;
	};

	const touches = new Map<number, { x: number; y: number }>();
	let press:
		| {
				x: number;
				y: number;
				az: number;
				ok: boolean;
				at: number;
				hold: boolean;
		  }
		| undefined;
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
			c.dragging = undefined;
			return;
		}
		const rect = canvasEl.getBoundingClientRect();
		const ok = !startsAtEdge(event.clientX, event.clientY, rect, {
			width: innerWidth,
			height: innerHeight,
		});
		press = {
			x: event.clientX,
			y: event.clientY,
			az: c.overviewAz,
			ok,
			at: performance.now(),
			// a finger that rests on a seat asks for its menu, and is not tapping
			hold: event.pointerType !== "mouse" && opts.onSeatMenu !== undefined,
		};
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
				c.zoom(intent === "in" ? -1 : 1);
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
		if (!press.ok || c.focusId !== null) return;
		const dx = event.clientX - press.x;
		if (Math.abs(dx) < TAP_PX && !c.dragging) return;
		const az = press.az + dragAngle(dx, canvasEl.clientWidth);
		c.dragging = { az };
		c.shot = overviewShot(
			az,
			c.countNow(),
			camera.aspect,
			canvasEl.clientWidth || undefined,
		);
		c.moveMs = 0;
		c.loop.wake();
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
		if (c.dragging) {
			// let go: settle on the nearest podium's place on the ring
			c.overviewAz = snapAngle(c.dragging.az, c.countNow());
			c.dragging = undefined;
			c.moveTo(
				overviewShot(
					c.overviewAz,
					c.countNow(),
					camera.aspect,
					canvasEl.clientWidth || undefined,
				),
				false,
			);
			return;
		}
		if (Math.hypot(dx, dy) < TAP_PX) {
			if (start.hold && performance.now() - start.at >= HOLD_MS) return;
			const found = hit(event.clientX, event.clientY);
			if (!found) return;
			if (found.kind === "agent" && found.seat) {
				const seat = c.seats.find((s) => s.id === found.seat);
				if (seat)
					opts.onSeatClick({
						id: seat.id,
						name: seat.name,
						at: { x: event.clientX, y: event.clientY },
					});
			} else if (found.kind === "owner" && c.focusId !== null)
				c.setFocus(null, false, true);
			return;
		}
		if (
			start.ok &&
			c.focusId !== null &&
			Math.abs(dx) >= SWIPE_PX &&
			Math.abs(dx) > Math.abs(dy)
		)
			c.step(swipeStep(dx));
	};
	const onCancel = (event: PointerEvent) => {
		touches.delete(event.pointerId);
		press = undefined;
		if (c.dragging) {
			c.overviewAz = snapAngle(c.dragging.az, c.countNow());
			c.dragging = undefined;
			c.moveTo(
				overviewShot(
					c.overviewAz,
					c.countNow(),
					camera.aspect,
					canvasEl.clientWidth || undefined,
				),
				false,
			);
		}
		canvasEl.style.cursor = "grab";
	};

	let wheelAt = 0;
	const onWheel = (event: WheelEvent) => {
		event.preventDefault();
		const now = performance.now();
		if (now - wheelAt < 450 || Math.abs(event.deltaY) < 4) return;
		wheelAt = now;
		c.zoom(event.deltaY);
	};

	/** Starts listening on the canvas. */
	const attach = () => {
		canvasEl.addEventListener("pointerdown", onDown);
		canvasEl.addEventListener("pointermove", onMove);
		canvasEl.addEventListener("pointerup", onUp);
		canvasEl.addEventListener("pointercancel", onCancel);
		canvasEl.addEventListener("wheel", onWheel, { passive: false });
	};
	/** Stops listening on the canvas. */
	const detach = () => {
		canvasEl.removeEventListener("pointerdown", onDown);
		canvasEl.removeEventListener("pointermove", onMove);
		canvasEl.removeEventListener("pointerup", onUp);
		canvasEl.removeEventListener("pointercancel", onCancel);
		canvasEl.removeEventListener("wheel", onWheel);
	};

	return { hit, attach, detach };
}
