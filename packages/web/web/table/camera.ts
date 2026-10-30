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

/** A standee board's half width and the top of its badge above the floor, in hall units: the extent a seat takes up in the picture. */
export const SEAT_HALF_WIDTH = 1.65;
/** Where a podium's name sits: its height above the floor, and half the width the name button takes on the screen, in CSS px (it is page text, not scene geometry, so it does not shrink with distance). */
const NAME_HEIGHT = 1.06;
const NAME_HALF_PX = 44;
/** The canvas width assumed when a caller does not say, in CSS px. */
const CANVAS_PX = 390;
export const SEAT_TOP = 4.8;
/** The share of the picture's half width and half height left empty beyond the outermost seat. */
export const FRAME_MARGIN = 0.07;
/** The furthest the overview pulls back to fit a crowded ring, as a multiple of its resting distance. */
export const MAX_PULLBACK = 3;

/** A point in world coordinates. */
export type Point3 = readonly [number, number, number];

/**
 * Where a world point lands in the picture of a shot at an aspect ratio (width / height), as normalised
 * device coordinates: -1…1 across and up the picture; `depth` is how far in front of the camera it is.
 * The picture's field of view is the shot's, widened for a narrow picture as the camera does.
 */
export function project(
	shot: Shot,
	aspect: number,
	point: Point3,
): { x: number; y: number; depth: number } {
	const { position, target } = shotVectors(shot);
	const forward = unit([
		target[0] - position[0],
		target[1] - position[1],
		target[2] - position[2],
	]);
	const right = unit(cross(forward, [0, 1, 0]));
	const up = cross(right, forward);
	const d: Point3 = [
		point[0] - position[0],
		point[1] - position[1],
		point[2] - position[2],
	];
	const depth = dot(d, forward);
	const tanV = Math.tan((fitFov(shot.fov, aspect) * Math.PI) / 360);
	const safe = depth > 1e-6 ? depth : Number.NaN;
	return {
		x: dot(d, right) / (safe * tanV * aspect),
		y: dot(d, up) / (safe * tanV),
		depth,
	};
}

const dot = (a: Point3, b: Point3): number =>
	a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Point3, b: Point3): Point3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];
const unit = (a: Point3): Point3 => {
	const length = Math.hypot(a[0], a[1], a[2]) || 1;
	return [a[0] / length, a[1] / length, a[2] / length];
};

/**
 * The corners of every agent podium's standee and the +N podium's, which the overview must keep in the
 * picture: the board's width across the podium's front, from the floor to the top of its badge.
 */
export function seatCorners(count: number): Point3[] {
	const ring = ringRadius(count);
	const corners: Point3[] = [];
	for (let slot = 1; slot < count; slot += 1) {
		const az = slotAngle(slot, count);
		// the tangent of the ring at the podium: its width runs along it
		const tx = Math.cos(az);
		const tz = -Math.sin(az);
		for (const side of [-1, 1])
			for (const height of [0, SEAT_TOP])
				corners.push([
					Math.sin(az) * ring + tx * side * SEAT_HALF_WIDTH,
					height,
					Math.cos(az) * ring + tz * side * SEAT_HALF_WIDTH,
				]);
	}
	return corners;
}

/** Whether every point lands inside the picture, a margin short of its edges. */
export function fits(
	shot: Shot,
	aspect: number,
	points: readonly Point3[],
	margin = FRAME_MARGIN,
	marginX = margin,
): boolean {
	const limitX = 1 - marginX;
	const limitY = 1 - margin;
	return points.every((point) => {
		const at = project(shot, aspect, point);
		return Math.abs(at.x) <= limitX && Math.abs(at.y) <= limitY;
	});
}

/** A standee board's width in hall units. */
export const BOARD_W = 2.9;
/**
 * Where the figure's hat, head and face stand on a standee board, as shares of the board's width (centred) and of its height from the top: the board has a margin above the hat and
 * the shoulders below the chin, so the face is not in its top half but between a fifth and four
 * fifths of the way down. A name must never cover this part.
 */
const HEAD_WIDTH_SHARE = 0.7;
const HEAD_TOP_SHARE = 0.2;
const HEAD_BOTTOM_SHARE = 0.8;

/**
 * The corners of a standee's head and face as a screen-facing rectangle: `centre` is the board's
 * centre in the world, `ratio` the board's height over its width and `eye` the camera. The board
 * turns toward the camera by up to a third of a turn, so a rectangle square to the line of sight is
 * the widest the head can look.
 */
export function headCorners(
	centre: Point3,
	ratio: number,
	eye: Point3,
): Point3[] {
	const dx = eye[0] - centre[0];
	const dz = eye[2] - centre[2];
	const length = Math.hypot(dx, dz) || 1;
	const rx = dz / length;
	const rz = -dx / length;
	const half = (BOARD_W * HEAD_WIDTH_SHARE) / 2;
	const height = BOARD_W * ratio;
	const top = centre[1] + height / 2 - height * HEAD_TOP_SHARE;
	const bottom = centre[1] + height / 2 - height * HEAD_BOTTOM_SHARE;
	const corners: Point3[] = [];
	for (const side of [-1, 1])
		for (const y of [top, bottom])
			corners.push([
				centre[0] + rx * side * half,
				y,
				centre[2] + rz * side * half,
			]);
	return corners;
}

/** The centre of every agent podium's name, which the overview must keep clear of the picture's sides by half the name's width. */
export function namePoints(count: number): Point3[] {
	const ring = ringRadius(count);
	const points: Point3[] = [];
	for (let slot = 1; slot < count; slot += 1) {
		const az = slotAngle(slot, count);
		points.push([Math.sin(az) * ring, NAME_HEIGHT, Math.cos(az) * ring]);
	}
	return points;
}

/** The shot moved back along its line of sight: `k` times as far from what it looks at. The camera and its target lie on one line through the hall's centre, so `az` stays. */
function pulledBack(shot: Shot, k: number): Shot {
	return {
		...shot,
		r: shot.lookR + (shot.r - shot.lookR) * k,
		y: shot.lookY + (shot.y - shot.lookY) * k,
	};
}

/**
 * The whole ring from a podium's side, raised: concept A's framing in concept B's palette. It stands
 * back as far as the ring needs, for the picture's aspect ratio (width / height), so that every seat
 * and its name stay in frame with a margin (`width` is the picture's width in CSS px, which the names' size depends on): a crowded ring or a tall, narrow picture pulls it back.
 */
export function overviewShot(
	az: number,
	count: number,
	aspect = 1.6,
	width = CANVAS_PX,
): Shot {
	const ring = ringRadius(count);
	const rest: Shot = {
		az,
		r: ring + 4.4,
		y: 4.4 + ring * 0.1,
		aim: 0,
		lookR: -1.6,
		lookY: 2.5,
		roll: 0,
		fov: 46,
	};
	if (!(aspect > 0)) return rest;
	const corners = seatCorners(count);
	const names = namePoints(count);
	const nameMarginX = FRAME_MARGIN + NAME_HALF_PX / (Math.max(width, 1) / 2);
	for (let k = 1; k <= MAX_PULLBACK; k += 0.02) {
		const shot = pulledBack(rest, k);
		if (
			fits(shot, aspect, corners) &&
			fits(shot, aspect, names, FRAME_MARGIN, nameMarginX)
		)
			return shot;
	}
	return pulledBack(rest, MAX_PULLBACK);
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
		lookY: 1.7,
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

/**
 * The dive from the whole ring into a seat: `cubic-bezier(0.7, 0, 0.84, 0)`, the same curve the page's
 * zoom into a room uses (lib/seat-dive.ts). It creeps at first and rushes in at the end.
 */
export const easeDive = (t: number): number => {
	const x = Math.min(1, Math.max(0, t));
	const axis = (s: number, a: number, b: number) =>
		3 * (1 - s) * (1 - s) * s * a + 3 * (1 - s) * s * s * b + s * s * s;
	// Find the curve's parameter whose x is `x`, then read its y.
	let low = 0;
	let high = 1;
	for (let i = 0; i < 24; i++) {
		const mid = (low + high) / 2;
		if (axis(mid, 0.7, 0.84) < x) low = mid;
		else high = mid;
	}
	return axis((low + high) / 2, 0, 0);
};

export const DIVE_TURN_MS = 420;
export const MIN_TURN_MS = 450;
export const MAX_TURN_MS = 650;

export interface Move {
	/** The time the move takes; 0 for a cut. */
	ms: number;
	/** Whether the camera jumps instead of moving. */
	cut: boolean;
	/** The move is the dive from the whole ring into a seat, which accelerates instead of easing in and out. */
	dive?: true;
}

/** A turn takes 450 ms for a short step and 650 ms for half the ring; reduced motion cuts. */
export function planMove(
	from: Shot,
	to: Shot,
	reduced: boolean,
	dive = false,
): Move {
	if (reduced) return { ms: 0, cut: true };
	if (dive) return { ms: DIVE_TURN_MS, cut: false, dive: true };
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
