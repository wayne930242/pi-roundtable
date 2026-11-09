import {
	closeupShot,
	fitFov,
	type Move,
	overviewShot,
	planMove,
	type Shot,
	type Slots,
	seatAhead,
	shotVectors,
	slotAngle,
	slotsFor,
	zoomIntent,
} from "./camera";
import type { Table3DContext } from "./table3d-context";

/** The camera of the hall: where it looks, how it moves there, and the close-up that follows a seat. */
export function cameraControls(c: Table3DContext) {
	const { opts, canvasEl, speed, camera } = c;
	const slotsNow = (): Slots => c.world?.slots ?? slotsFor(c.seats.length);
	const countNow = () => slotsNow().count;
	const seatAz = (id: string): number | undefined => {
		const slot = c.world?.slotOf.get(id);
		return slot === undefined ? undefined : slotAngle(slot, countNow());
	};
	const targetShot = (): Shot => {
		const az = c.focusId ? seatAz(c.focusId) : undefined;
		return az === undefined
			? overviewShot(
					c.overviewAz,
					countNow(),
					camera.aspect,
					canvasEl.clientWidth || undefined,
				)
			: closeupShot(az, countNow());
	};
	const applyCamera = () => {
		const { position, target } = shotVectors(c.shot);
		camera.position.set(...position);
		camera.lookAt(target[0], target[1], target[2]);
		camera.rotateZ(c.shot.roll);
		const fov = fitFov(c.shot.fov, camera.aspect);
		if (Math.abs(camera.fov - fov) > 1e-3) {
			camera.fov = fov;
			camera.updateProjectionMatrix();
		}
	};
	const moveTo = (target: Shot, cut: boolean, dive = false): Move => {
		const plan = planMove(c.shot, target, c.reduced || cut, dive);
		c.moveDive = plan.dive === true;
		if (plan.cut) {
			c.shot = target;
			c.moveMs = 0;
		} else {
			c.camFrom = c.shot;
			c.camTo = target;
			c.moveStart = performance.now();
			c.moveMs = plan.ms;
		}
		c.loop.wake();
		return plan;
	};

	const setFocus = (id: string | null, cut: boolean, fromPerson: boolean) => {
		const wanted = id !== null && c.world?.slotOf.has(id) ? id : null;
		if (wanted === c.focusId) return;
		const entering = wanted !== null && c.focusId === null;
		c.focusId = wanted;
		// From the whole ring into a seat the camera dives; between seats and back out it turns.
		const plan = moveTo(targetShot(), cut, entering);
		if (wanted !== null && c.primed && !plan.cut) speed.play();
		if (fromPerson) opts.onFocus?.(wanted);
	};

	/** Moves a close-up to the next (+1) or previous (-1) agent round the ring. */
	const step = (direction: 1 | -1) => {
		const w = c.world;
		if (!w || c.focusId === null || w.order.length < 2) return;
		const at = w.order.indexOf(c.focusId);
		const next = w.order[(at + direction + w.order.length) % w.order.length];
		if (next) setFocus(next, false, true);
	};

	/** A wheel turn or a pinch: closer to the podium across the ring, or back out to the whole ring. */
	const zoom = (delta: number) => {
		const w = c.world;
		if (!w) return;
		const intent = zoomIntent(delta, c.focusId !== null);
		if (intent === "in") {
			const slot = seatAhead(c.overviewAz, w.slots);
			const id = slot === undefined ? undefined : w.order[slot - 1];
			if (id) setFocus(id, false, true);
		} else if (intent === "out") setFocus(null, false, true);
	};

	return {
		slotsNow,
		countNow,
		seatAz,
		targetShot,
		applyCamera,
		moveTo,
		setFocus,
		step,
		zoom,
	};
}
