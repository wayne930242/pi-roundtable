import { slotsFor } from "./camera";
import { Effects } from "./fx3d";
import {
	FADE_MS,
	glideProgress,
	leavePose,
	RISE_DEPTH,
	risePose,
	type SeatingPlan,
	turnToward,
} from "./seating";
import type { Table3DContext } from "./table3d-context";
import {
	keyOf,
	type Place,
	PUFF_Y,
	REST_Y,
	type Show,
} from "./table3d-context";
import type { SeatInit } from "./types";

/** The change of the ring when seats leave or join: the puff, the glide and the rise. */
export function showControls(c: Table3DContext) {
	const { canvasEl, names, scene } = c;
	const shownIds = (list: readonly SeatInit[]) =>
		list.slice(0, slotsFor(list.length).seated).map((s) => s.id);

	const placesOf = (): Map<string, Place> => {
		const found = new Map<string, Place>();
		for (const p of c.world?.podiums ?? [])
			found.set(keyOf(p), {
				x: p.group.position.x,
				z: p.group.position.z,
				yaw: p.group.rotation.y,
			});
		return found;
	};

	/** The ring is re-planned for the new seats: the others start to glide, and the ones that come wait out of sight. */
	const swap = (s: Show) => {
		s.swapped = true;
		const from = placesOf();
		c.seats = s.next;
		s.slides = [];
		c.build({ from, joining: new Set(s.plan.joining) });
		for (const p of s.risers)
			s.fx?.circle(
				{ x: p.group.position.x, y: REST_Y, z: p.group.position.z },
				s.plan.riseAt,
			);
	};

	/** The show is over, or cut short: everything stands where the new ring puts it. */
	const finish = (s: Show) => {
		for (const t of s.timers) clearTimeout(t);
		for (const slide of s.slides) {
			slide.podium.group.position.x = slide.to.x;
			slide.podium.group.position.z = slide.to.z;
			slide.podium.group.rotation.y = slide.to.yaw;
		}
		for (const p of s.risers) {
			p.group.visible = true;
			p.group.position.y = REST_Y;
			p.labelHidden = false;
		}
		s.fx?.dispose();
		canvasEl.style.transition = "";
		canvasEl.style.opacity = "";
		names.root.style.transition = "";
		names.root.style.opacity = "";
		if (c.show === s) c.show = undefined;
		c.loop.wake();
	};

	/** Brings a show to its end at once, for a change that cannot wait for it. */
	const endShow = () => {
		const s = c.show;
		if (!s) return;
		if (!s.swapped) {
			s.swapped = true;
			c.seats = s.next;
			c.build();
		}
		finish(s);
	};

	/** Starts the puff, the glide and the rise for a new ring, or the quick dip under reduced motion. */
	const startShow = (next: SeatInit[], plan: SeatingPlan) => {
		const s: Show = {
			plan,
			start: performance.now(),
			next,
			leavers: [],
			swapped: false,
			fx: undefined,
			slides: [],
			risers: [],
			timers: [],
		};
		c.show = s;
		if (plan.mode === "fade") {
			for (const el of [canvasEl, names.root]) {
				el.style.transition = `opacity ${FADE_MS}ms linear`;
				el.style.opacity = "0";
			}
			s.timers.push(
				setTimeout(() => {
					s.swapped = true;
					c.seats = next;
					c.build();
					for (const el of [canvasEl, names.root]) el.style.opacity = "1";
				}, FADE_MS),
				setTimeout(() => finish(s), FADE_MS * 2),
			);
			return;
		}
		const w = c.world;
		if (!w) return;
		const fx = new Effects(w.hall);
		s.fx = fx;
		scene.add(fx.group);
		for (const id of plan.leaving) {
			const slot = w.slotOf.get(id);
			const podium = slot === undefined ? undefined : w.podiums[slot];
			if (!podium) continue;
			s.leavers.push(podium);
			fx.puff(
				{ x: podium.group.position.x, y: PUFF_Y, z: podium.group.position.z },
				0,
			);
		}
		if (plan.swapAt === 0) swap(s);
		c.loop.wake();
	};

	/** Moves the show to `now`; true while it is still going. */
	const stepShow = (now: number): boolean => {
		const s = c.show;
		if (!s || s.plan.mode !== "play") return s !== undefined;
		const ms = Math.max(0, now - s.start);
		if (!s.swapped) {
			const pose = leavePose(ms);
			for (const p of s.leavers) {
				p.group.scale.set(pose.scaleX, pose.scaleY, pose.scaleX);
				if (pose.gone) p.group.visible = false;
			}
			if (ms >= s.plan.swapAt) swap(s);
		}
		if (s.swapped) {
			const t = glideProgress(ms - s.plan.swapAt);
			for (const { podium, from, to } of s.slides) {
				podium.group.position.x = from.x + (to.x - from.x) * t;
				podium.group.position.z = from.z + (to.z - from.z) * t;
				podium.group.rotation.y = turnToward(from.yaw, to.yaw, t);
			}
			const rise = risePose(ms - s.plan.riseAt);
			for (const p of s.risers) {
				p.group.visible = rise.shown;
				p.group.position.y = REST_Y - rise.depth * RISE_DEPTH;
				p.labelHidden = !rise.named;
			}
		}
		const running = s.fx?.step(ms) ?? false;
		if (ms >= s.plan.total && !running) {
			finish(s);
			return false;
		}
		return true;
	};

	return { shownIds, placesOf, swap, finish, endShow, startShow, stepShow };
}
