/**
 * The council hall's cameras as plain numbers, so the planner is tested without WebGL. Everything is
 * measured around the hall's centre: a shot is where the camera stands on a circle (`az`, `r`, `y`),
 * where it looks (a point `lookR` out along `az + aim`, at `lookY`) and how it is tilted. A turn
 * between two shots moves `az` along the shorter arc of the ring and blends the rest.
 */

export const TAU = Math.PI * 2;

/** The most agents the ring seats; more of them stand behind one "+N" podium that opens the list. */
export const MAX_SEATED = 12;

export interface Shot {
	/** Where the camera stands on the ring, in radians from the owner's podium (which is at 0). */
	az: number;
	/** How far it stands from the centre. */
	r: number;
	y: number;
	/** The direction it looks, relative to `az`. */
	aim: number;
	lookR: number;
	lookY: number;
	/** Dutch tilt. */
	roll: number;
	/** Vertical field of view, degrees. */
	fov: number;
}

/** An angle as the same direction within (-π, π]. */
export function normalizeAngle(angle: number): number {
	const wrapped = ((((angle + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
	return wrapped === -Math.PI ? Math.PI : wrapped;
}

/** The signed turn from `from` to `to` by the shorter way round the ring. */
export const shortestArc = (from: number, to: number): number =>
	normalizeAngle(to - from);

/** The slots of the ring: the owner's podium, the seated agents, and a "+N" podium when some are left out. */
export interface Slots {
	/** Every podium, the owner's included. */
	count: number;
	/** The agents standing on the ring. */
	seated: number;
	/** How many agents are left out and stand behind the "+N" podium. */
	more: number;
}

export function slotsFor(agents: number): Slots {
	const seated = Math.min(Math.max(agents, 0), MAX_SEATED);
	const more = Math.max(agents - MAX_SEATED, 0);
	return { count: 1 + seated + (more > 0 ? 1 : 0), seated, more };
}

/** The most the podiums of a small table stand apart, in radians: the agents sit as a council facing the owner, not spread over the whole ring. */
export const SPACING_MAX = 0.62;

/** The angle between two neighbouring agents' podiums. */
export const spacingFor = (count: number): number =>
	Math.min(TAU / Math.max(count, 1), SPACING_MAX);

/**
 * Where a podium stands on the ring. Slot 0 is the owner's, at the camera's home; the agents'
 * podiums stand side by side across the ring from it, centred on the far side, and fill the ring
 * evenly when there are many.
 */
export const slotAngle = (slot: number, count: number): number =>
	slot === 0
		? 0
		: normalizeAngle(Math.PI + (slot - count / 2) * spacingFor(count));

/** The ring's radius: wide enough that neighbouring podiums stand at least 2.6 units apart. */
export const ringRadius = (count: number): number =>
	Math.max(4.2, 2.6 / (2 * Math.sin(spacingFor(count) / 2)));

/** The slot nearest to a direction. */
export function nearestSlot(az: number, count: number): number {
	let best = 0;
	let gap = Number.POSITIVE_INFINITY;
	for (let slot = 0; slot < count; slot += 1) {
		const arc = Math.abs(shortestArc(az, slotAngle(slot, count)));
		if (arc < gap - 1e-9) {
			gap = arc;
			best = slot;
		}
	}
	return best;
}

/** Where a drag ends up: the camera snaps to the nearest podium's place on the ring. */
export const snapAngle = (az: number, count: number): number =>
	slotAngle(nearestSlot(az, count), count);

/** The agent's slot (not the owner's) the camera faces from `az`: the one across the ring from it. */
export function seatAhead(az: number, slots: Slots): number | undefined {
	if (slots.seated === 0) return undefined;
	const across = normalizeAngle(az + Math.PI);
	let best: number | undefined;
	let gap = Number.POSITIVE_INFINITY;
	for (let slot = 1; slot <= slots.seated; slot += 1) {
		const arc = Math.abs(shortestArc(across, slotAngle(slot, slots.count)));
		if (arc < gap - 1e-9) {
			gap = arc;
			best = slot;
		}
	}
	return best;
}

/** The whole ring from a podium's side, raised: concept A's framing in concept B's palette. */
export function overviewShot(az: number, count: number): Shot {
	const ring = ringRadius(count);
	return {
		az,
		r: ring + 4.4,
		y: 4.4 + ring * 0.1,
		aim: 0,
		lookR: -1.6,
		lookY: 2.5,
		roll: 0,
		fov: 46,
	};
}

/** The speaker large in the frame from just inside the ring, a little low, off to a side, tilted. */
export function closeupShot(seatAz: number, count: number): Shot {
	const ring = ringRadius(count);
	const side = 0.18;
	return {
		az: normalizeAngle(seatAz + side),
		r: Math.max(ring - 3.9, 0.5),
		y: 1.8,
		aim: -side,
		lookR: ring + 0.1,
		lookY: 2.25,
		roll: -0.16,
		fov: 58,
	};
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** A point on the way between two shots: `az` takes the shorter arc, the rest is blended. */
export function blendShot(from: Shot, to: Shot, t: number): Shot {
	return {
		az: normalizeAngle(from.az + shortestArc(from.az, to.az) * t),
		r: lerp(from.r, to.r, t),
		y: lerp(from.y, to.y, t),
		aim: lerp(from.aim, to.aim, t),
		lookR: lerp(from.lookR, to.lookR, t),
		lookY: lerp(from.lookY, to.lookY, t),
		roll: lerp(from.roll, to.roll, t),
		fov: lerp(from.fov, to.fov, t),
	};
}

export const easeInOut = (t: number): number => {
	const x = Math.min(1, Math.max(0, t));
	return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};

export const MIN_TURN_MS = 450;
export const MAX_TURN_MS = 650;

export interface Move {
	/** The time the move takes; 0 for a cut. */
	ms: number;
	/** Whether the camera jumps instead of moving. */
	cut: boolean;
}

/** A turn takes 450 ms for a short step and 650 ms for half the ring; reduced motion cuts. */
export function planMove(from: Shot, to: Shot, reduced: boolean): Move {
	if (reduced) return { ms: 0, cut: true };
	const arc = Math.abs(shortestArc(from.az, to.az)) / Math.PI;
	return {
		ms: Math.round(MIN_TURN_MS + (MAX_TURN_MS - MIN_TURN_MS) * arc),
		cut: false,
	};
}

/** The camera's position and what it looks at, in world coordinates. */
export function shotVectors(shot: Shot): {
	position: [number, number, number];
	target: [number, number, number];
} {
	const look = shot.az + shot.aim;
	return {
		position: [Math.sin(shot.az) * shot.r, shot.y, Math.cos(shot.az) * shot.r],
		target: [
			Math.sin(look) * shot.lookR,
			shot.lookY,
			Math.cos(look) * shot.lookR,
		],
	};
}

/** Where a podium stands, and which way its front looks (toward the centre). */
export function podiumPlace(
	slot: number,
	count: number,
): { x: number; z: number; yaw: number } {
	const az = slotAngle(slot, count);
	const ring = ringRadius(count);
	return {
		x: Math.sin(az) * ring,
		z: Math.cos(az) * ring,
		yaw: az + Math.PI,
	};
}

/** How far a drag of `dx` px along a canvas `width` px wide turns the camera: a full width is a quarter of the ring. */
export const dragAngle = (dx: number, width: number): number =>
	(-dx / Math.max(width, 1)) * (Math.PI / 2);

/** A swipe must not start this close to the screen's edge, where the system's own gestures live. */
export const EDGE_PX = 32;

export function startsAtEdge(
	x: number,
	y: number,
	box: { left: number; top: number; width: number; height: number },
	screen: { width: number; height: number },
): boolean {
	const edge = (px: number, min: number, max: number) =>
		px - min < EDGE_PX || max - px < EDGE_PX;
	return (
		edge(x, 0, screen.width) ||
		edge(y, 0, screen.height) ||
		edge(x, box.left, box.left + box.width) ||
		edge(y, box.top, box.top + box.height)
	);
}

export type ZoomIntent = "in" | "out" | "none";

/** What a wheel turn or a pinch means: closer to a podium, or back to the whole ring. */
export function zoomIntent(delta: number, focused: boolean): ZoomIntent {
	if (Math.abs(delta) < 1e-6) return "none";
	if (delta < 0) return focused ? "none" : "in";
	return focused ? "out" : "none";
}

/** The slot (and its id in `ids`) a hash such as `#/table/<agent>` names; the overview when it names none. */
export function focusOf(
	ids: readonly string[],
	wanted: string | null | undefined,
): string | null {
	return wanted && ids.includes(wanted) ? wanted : null;
}

/** A tall, narrow view needs a wider field to keep the same scene in frame. */
export function fitFov(fov: number, aspect: number): number {
	if (!(aspect > 0) || aspect >= 1.2) return fov;
	return Math.min(fov * (1 + (1.2 - aspect) * 0.55), 95);
}
