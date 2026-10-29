import { easeInOut, shortestArc } from "./camera";

/**
 * How the ring changes when agents leave or join the table, as plain numbers so the sequence is
 * tested without WebGL. An agent that leaves goes in a puff of smoke; the others then glide to their
 * new places, and an agent that joins rises out of a rune circle once the gap is open.
 */

/** The puff of a leaving seat, from the first squash to the last cloud gone. */
export const PUFF_MS = 720;
/** The moment the standee has squashed and is hidden inside the clouds. */
export const VANISH_MS = 260;
/** The ring is re-planned this long after a puff starts: the clouds still hang over the empty place. */
export const SWAP_AFTER_PUFF_MS = 380;
/** The other seats' glide to their new places. */
export const GLIDE_MS = 600;
/** A joining seat's rune circle and rise. */
export const RISE_MS = 850;
/** Under reduced motion the picture dips and comes back, this long each way. */
export const FADE_MS = 160;

/** How far under the dais a podium waits before it rises, in scene units. */
export const RISE_DEPTH = 4.2;
/** A joining seat's name waits until the podium is this far up (its depth, 1 under the dais to 0 standing). */
const NAME_DEPTH = 0.35;

export type SeatingMode =
	/** The ring changes at once: only a reorder or a rename. */
	| "cut"
	/** Reduced motion: the picture dips and the ring changes while it is down. */
	| "fade"
	/** The smoke, the glide and the rise. */
	| "play";

export interface SeatingPlan {
	mode: SeatingMode;
	/** The seats that go, in the order the old ring had them. */
	leaving: string[];
	/** The seats that come, in the order the new ring has them. */
	joining: string[];
	/** The seats that are on both rings. */
	staying: string[];
	/** When the ring is rebuilt for the new seats: the leavers are gone by then and the others start to glide. */
	swapAt: number;
	/** When the glide of the staying seats and the camera ends. */
	glideEnd: number;
	/** When the joiners start to rise, and when they stand. */
	riseAt: number;
	riseEnd: number;
	/** When everything has ended and the effects can go. */
	total: number;
}

/** Which seats animate and when, from the ids of the old and the new ring. */
export function planSeating(
	before: readonly string[],
	after: readonly string[],
	reduced: boolean,
): SeatingPlan {
	const was = new Set(before);
	const is = new Set(after);
	const leaving = before.filter((id) => !is.has(id));
	const joining = after.filter((id) => !was.has(id));
	const staying = after.filter((id) => was.has(id));
	const plan = {
		leaving,
		joining,
		staying,
		swapAt: 0,
		glideEnd: 0,
		riseAt: 0,
		riseEnd: 0,
		total: 0,
	};
	if (leaving.length === 0 && joining.length === 0)
		return { mode: "cut", ...plan };
	if (reduced)
		return {
			mode: "fade",
			...plan,
			swapAt: FADE_MS,
			glideEnd: FADE_MS,
			riseAt: FADE_MS,
			riseEnd: FADE_MS,
			total: FADE_MS * 2,
		};
	const swapAt = leaving.length > 0 ? SWAP_AFTER_PUFF_MS : 0;
	const glideEnd = swapAt + GLIDE_MS;
	const riseAt = glideEnd;
	const riseEnd = joining.length > 0 ? riseAt + RISE_MS : glideEnd;
	return {
		mode: "play",
		...plan,
		swapAt,
		glideEnd,
		riseAt,
		riseEnd,
		total: Math.max(
			leaving.length > 0 ? PUFF_MS : 0,
			glideEnd,
			joining.length > 0 ? riseEnd : 0,
		),
	};
}

const clamp = (value: number, low = 0, high = 1) =>
	Math.min(high, Math.max(low, value));

/** Eases out past the end and settles back: the small bounce of a rise. */
export function backOut(t: number): number {
	const x = clamp(t);
	const c = 1.70158;
	return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2;
}

export interface LeavePose {
	/** The standee's squash before it vanishes. */
	scaleX: number;
	scaleY: number;
	/** The standee and its podium are hidden inside the clouds. */
	gone: boolean;
	/** 0 to 1 over the whole puff: the clouds swell, drift up and fade. */
	puff: number;
}

/** A leaving seat `ms` after the puff started. */
export function leavePose(ms: number): LeavePose {
	const squash = Math.sin(Math.PI * clamp(ms / VANISH_MS));
	return {
		scaleX: 1 + 0.08 * squash,
		scaleY: 1 - 0.14 * squash,
		gone: ms >= VANISH_MS,
		puff: clamp(ms / PUFF_MS),
	};
}

export interface RisePose {
	/** The podium is shown at all: it waits hidden while the others glide. */
	shown: boolean;
	/** 1 while it waits under the dais, 0 when it stands; below 0 at the top of the bounce. */
	depth: number;
	/** The rune circle's strength, 0 to 1: it glows first, and fades last. */
	circle: number;
	/** The light column and sparkles that go up as the podium comes. */
	light: number;
	/** The circle's turn, radians. */
	spin: number;
	/** The name over the podium is shown: only once the podium is shown and has come most of the way up. */
	named: boolean;
}

/** A joining seat `ms` after its rise began (negative while the others still glide). */
export function risePose(ms: number): RisePose {
	if (ms < 0)
		return {
			shown: false,
			depth: 1,
			circle: 0,
			light: 0,
			spin: 0,
			named: false,
		};
	const t = clamp(ms / RISE_MS);
	const lift = clamp((t - 0.25) / 0.6);
	const depth = 1 - backOut(lift);
	return {
		shown: t >= 0.25,
		depth,
		named: t >= 0.25 && depth <= NAME_DEPTH,
		circle: clamp(t / 0.25) * clamp((1 - t) / 0.2),
		light: Math.sin(Math.PI * clamp((t - 0.2) / 0.7)),
		spin: t * Math.PI * 1.5,
	};
}

/** How far through its glide a staying seat is, eased, `ms` after the ring was re-planned. */
export const glideProgress = (ms: number): number =>
	easeInOut(clamp(ms / GLIDE_MS));

/** An angle on the way from `from` to `to` by the shorter turn. */
export const turnToward = (from: number, to: number, t: number): number =>
	from + shortestArc(from, to) * t;
