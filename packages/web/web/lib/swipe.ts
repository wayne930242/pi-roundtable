// The swipe that opens and closes the room switcher, as plain functions and one small state
// machine, so its thresholds can be tested without a touch screen.

/**
 * A touch that starts this close to the right screen edge is left to the system, and so is a
 * thread card's swipe near either edge: many phones use an edge swipe for Back. The drawer opens
 * from the left edge too, where the system lets the page have the touch (see `OPEN_ZONE`).
 */
export const EDGE_GUARD = 32;
/** A swipe right opens the drawer from anywhere in this share of the screen's width, counted from the left. */
export const OPEN_ZONE = 0.5;
/** How far the finger moves before the swipe is judged. */
export const MIN_DISTANCE = 24;
/** The horizontal motion must be this many times the vertical one. */
export const AXIS_RATIO = 1.5;
/** The share of the drawer's width that is enough to open it. */
export const OPEN_FRACTION = 0.4;
/** A flick this fast (px per ms) decides the swipe, wherever it ends. */
export const FLICK_SPEED = 0.5;
/** The last stretch of the drag that the finger's speed is read from. */
const SPEED_WINDOW_MS = 100;

/** The drawer's width: 80 % of the screen, at most 360 px. Keep in step with `.switcher-panel`. */
export const drawerWidth = (viewport: number): number =>
	Math.min(Math.round(viewport * 0.8), 360);

/** Whether a touch at `x` starts within the guard of either edge of a screen `viewport` wide. */
export const atScreenEdge = (x: number, viewport: number): boolean =>
	x < EDGE_GUARD || x > viewport - EDGE_GUARD;

/**
 * Whether a touch at `x` may start the swipe that moves a drawer `from` closed or open. Opening
 * takes the left half of the screen, edge included; closing takes the screen but the right edge,
 * which the system keeps for Back.
 */
export const startsSwipe = (
	from: "closed" | "open",
	x: number,
	viewport: number,
): boolean =>
	from === "closed" ? x <= viewport * OPEN_ZONE : x < viewport - EDGE_GUARD;

export type Axis = "wait" | "reject" | "horizontal";

/** What a finger that moved (dx, dy) from where it started is doing. */
export function axisOf(dx: number, dy: number): Axis {
	const across = Math.abs(dx);
	const down = Math.abs(dy);
	if (across >= MIN_DISTANCE && across > AXIS_RATIO * down) return "horizontal";
	return down >= MIN_DISTANCE ? "reject" : "wait";
}

/**
 * Whether a drag that ended at `progress` (0 closed, 1 open) with `velocity` (px per ms, positive
 * to the right) leaves the drawer open. A drawer that was open closes once dragged 40 % of its width.
 */
export function settles(
	progress: number,
	velocity: number,
	from: "closed" | "open" = "closed",
): boolean {
	if (velocity >= FLICK_SPEED) return true;
	if (velocity <= -FLICK_SPEED) return false;
	return from === "closed"
		? progress >= OPEN_FRACTION
		: progress > 1 - OPEN_FRACTION;
}

export type SwipeState = "idle" | "wait" | "reject" | "drag";

/** One finger's swipe on a drawer that is `from` closed or open. */
export class Swipe {
	readonly #from: "closed" | "open";
	readonly #viewport: number;
	#origin: { x: number; y: number } | undefined;
	#samples: { x: number; t: number }[] = [];
	#state: SwipeState = "idle";
	#progress = 0;

	constructor(from: "closed" | "open", viewport: number) {
		this.#from = from;
		this.#viewport = viewport;
	}

	/** Starts the swipe; false when the touch is outside the zone that moves this drawer (see `startsSwipe`). */
	begin(x: number, y: number, t: number): boolean {
		if (!startsSwipe(this.#from, x, this.#viewport)) return false;
		this.#origin = { x, y };
		this.#samples = [{ x, t }];
		this.#state = "wait";
		this.#progress = this.#from === "open" ? 1 : 0;
		return true;
	}

	move(
		x: number,
		y: number,
		t: number,
	): { state: SwipeState; progress: number } {
		const origin = this.#origin;
		if (!origin || this.#state === "reject")
			return { state: this.#state, progress: this.#progress };
		const dx = x - origin.x;
		const dy = y - origin.y;
		if (this.#state === "wait") {
			const axis = axisOf(dx, dy);
			if (axis === "wait") return { state: "wait", progress: this.#progress };
			// Opening goes right, closing goes left; the other way is not ours.
			const wanted = this.#from === "closed" ? dx > 0 : dx < 0;
			this.#state = axis === "horizontal" && wanted ? "drag" : "reject";
			if (this.#state === "reject")
				return { state: "reject", progress: this.#progress };
		}
		this.#samples.push({ x, t });
		const width = drawerWidth(this.#viewport);
		const raw = (this.#from === "closed" ? 0 : 1) + dx / width;
		this.#progress = Math.min(1, Math.max(0, raw));
		return { state: "drag", progress: this.#progress };
	}

	/**
	 * Whether the drawer ends open, or undefined when this was never a drag of ours. `at` is when the
	 * finger lifted: a finger that rested before it lifted is not flicking.
	 */
	finish(at?: number): boolean | undefined {
		if (this.#state !== "drag") return undefined;
		return settles(this.#progress, this.#speed(at), this.#from);
	}

	#speed(at: number | undefined): number {
		const last = this.#samples.at(-1);
		if (!last) return 0;
		if (at !== undefined && at - last.t > SPEED_WINDOW_MS) return 0;
		const first = this.#samples.find((s) => last.t - s.t <= SPEED_WINDOW_MS);
		if (!first || last.t <= first.t) return 0;
		return (last.x - first.x) / (last.t - first.t);
	}
}

const SIDEWAYS =
	"input, textarea, select, [contenteditable], [data-swipe-ignore]";

/** Whether the element has taken every touch for its own gesture (`touch-action: none`), as a drawn scene does. */
const takesTouch = (element: Element): boolean =>
	getComputedStyle(element).touchAction === "none";

/** Whether the element scrolls sideways now, as a wide code block or table does. */
function scrollsSideways(element: Element): boolean {
	if (element.scrollWidth <= element.clientWidth + 1) return false;
	const overflow = getComputedStyle(element).overflowX;
	return overflow === "auto" || overflow === "scroll";
}

/**
 * Whether a touch that begins at `target` belongs to something else: a field, anything marked
 * `data-swipe-ignore` (a card's option row), or an element between it and `stop` that scrolls sideways
 * or takes every touch.
 */
export function blocksSwipe(
	target: EventTarget | null,
	stop: Element,
): boolean {
	let element = target instanceof Element ? target : null;
	while (element) {
		if (
			element.matches(SIDEWAYS) ||
			scrollsSideways(element) ||
			takesTouch(element)
		)
			return true;
		if (element === stop) return false;
		element = element.parentElement;
	}
	return false;
}

/**
 * Whether a touch at `target` is on a dialog or sheet drawn over the page, or on something React
 * delivered here from outside `stop` (a portal): what those show is theirs, not the room's.
 */
export function overPage(target: EventTarget | null, stop: Element): boolean {
	if (!(target instanceof Element) || !stop.contains(target)) return true;
	return target.closest('[aria-modal="true"], dialog') !== null;
}
