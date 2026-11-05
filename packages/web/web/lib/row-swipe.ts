// The sideways swipe that a row of a list answers: a dispatch thread's card clears itself, a room's
// row marks the room read to the right and turns its modes to the left. This holds how a finger is told from a scroll, a tap and a hold, how far the
// row follows it, and when the swipe counts; what the row does is the caller's.

import { LongPress, type Point } from "./long-press.ts";
import { reducedMotion } from "./motion.ts";
import { armTouches } from "./row-press.ts";
import { AXIS_RATIO, atScreenEdge, settles } from "./swipe.ts";

/** How far (px) the finger goes sideways before the swipe is told from a scroll or a tap. */
const INTENT = 12;
/** The most (px) a row that cannot act gives to a finger that pulls it, before it pulls back. */
const RUBBER_MAX = 24;
const SLIDE_MS = 180;
/** A row that springs back moves this share of the finger's distance: a pull, not a slide. */
const PULL_DAMPING = 0.5;
/** The travel (px) past which a pull that springs back meets rubber, and the most it ever travels. */
const PULL_SOFT = 64;
const PULL_CAP = 80;
/** The travel (px) past which a pull that springs back acts when it is let go. */
export const PULL_ARM = 56;
/** The last stretch of the drag (ms) that the finger's speed is read from. */
const SPEED_WINDOW_MS = 100;

/** What a list's rows do under a sideways swipe. */
export interface RowSwipeSpec {
	/** The way the row follows the finger; right when unsaid. A row may carry one spec each way. */
	direction?: "right" | "left";
	/** The rows, as a selector: the element that follows the finger. */
	row: string;
	/** Parts of a row that are not the row, such as its menu button. */
	ignore?: string;
	/** Whether the row would act now; one that would not only gives a little. */
	can(row: HTMLElement): boolean;
	/** The row was let go past the threshold, or flicked. */
	act(row: HTMLElement): void;
	/** The row leaves by itself in `act` (a cleared card); otherwise it springs back first. */
	leaves: boolean;
	/** The row is already on its way out and is left alone. */
	busy?(row: HTMLElement): boolean;
	/** The finger rested on the row: the hold is its menu. Without it the hold only ends the swipe. */
	hold?(row: HTMLElement, at: Point): void;
	/** What the row uncovers as it follows the finger; shown while it is pulled. */
	reveal?(row: HTMLElement): HTMLElement | null;
}

export interface RowSwipe {
	/** A swipe or a hold just happened, so the click or menu event that follows is not the row's. */
	readonly swallowing: boolean;
	/** Forgets the swipe or hold that came before, as a key press does. */
	forget(): void;
	/** Gives up the hold of the finger that is down, if any. */
	cancelHold(): void;
	/** Takes the swipe off the list again. */
	detach(): void;
}

/** One finger on a row, from its touch to its lift. */
interface Finger {
	id: number;
	row: HTMLElement;
	origin: Point;
	press: LongPress;
	/** Where the finger is judged: a swipe from a screen edge belongs to the system. */
	swipes: boolean;
	state: "wait" | "drag" | "reject";
	offset: number;
	/** How far (px) the finger has pulled past the intent, before damping. */
	pulled: number;
	samples: { x: number; t: number }[];
}

/** How far (px) a row that springs back travels under a finger that pulled it `pulled` px. */
export function pullTravel(pulled: number): number {
	const damped = Math.max(0, pulled) * PULL_DAMPING;
	if (damped <= PULL_SOFT) return damped;
	const room = PULL_CAP - PULL_SOFT;
	return PULL_SOFT + room * (1 - Math.exp(-(damped - PULL_SOFT) / room));
}

const keepScroll = (event: TouchEvent) => {
	if (event.cancelable) event.preventDefault();
};

/** How fast (px per ms) the finger was going the swipe's way (`sign`) when it lifted at `at`. */
function speedOf(samples: Finger["samples"], at: number, sign: number): number {
	const last = samples.at(-1);
	if (!last || at - last.t > SPEED_WINDOW_MS) return 0;
	const first = samples.find((one) => last.t - one.t <= SPEED_WINDOW_MS);
	if (!first || last.t <= first.t) return 0;
	return (sign * (last.x - first.x)) / (last.t - first.t);
}

/**
 * Gives the rows inside `root` the swipe of `spec`. A row that can act and leaves follows a finger its
 * way and acts when it is let go past 40 % of its width, or flicked. One that springs back is
 * pulled: it moves half the finger's way up to `PULL_CAP`, arms past `PULL_ARM` of travel, and acts
 * when let go armed, or flicked. One that cannot act only gives a little and comes back. A swipe the other way, a scroll, an edge swipe and a hold are not the swipe.
 */
export function attachRowSwipe(
	root: HTMLElement,
	spec: RowSwipeSpec,
): RowSwipe {
	const sign = spec.direction === "left" ? -1 : 1;
	const disarm = armTouches();
	let finger: Finger | undefined;
	/** A swipe or a hold happened: the click that follows the lift must not open the row. */
	let swallow = false;

	const rowOf = (target: EventTarget | null): HTMLElement | null =>
		target instanceof Element ? target.closest<HTMLElement>(spec.row) : null;

	const showReveal = (row: HTMLElement, shown: boolean) => {
		const reveal = spec.reveal?.(row);
		if (!reveal) return;
		if ("armed" in row.dataset) reveal.dataset.armed = "";
		else delete reveal.dataset.armed;
		if (!shown) {
			delete reveal.dataset.shown;
			return;
		}
		reveal.style.top = `${row.offsetTop}px`;
		reveal.style.height = `${row.offsetHeight}px`;
		reveal.dataset.shown = "";
	};

	const end = () => {
		finger?.press.cancel();
		window.removeEventListener("touchmove", keepScroll);
		finger = undefined;
	};

	/** The row back at rest under a finger that is no longer pulling it. */
	const resetPull = (row: HTMLElement) => {
		if (spec.busy?.(row)) return;
		delete row.dataset.armed;
		row.style.transition = `transform ${reducedMotion() ? 0 : SLIDE_MS}ms var(--ease-out)`;
		row.style.transform = "";
		if (spec.reveal) {
			delete row.dataset.swiping;
			showReveal(row, false);
		}
	};

	const onDown = (event: PointerEvent) => {
		swallow = false;
		if (event.pointerType === "mouse" || !event.isPrimary) return;
		const row = rowOf(event.target);
		if (!row || (spec.ignore && (event.target as Element).closest(spec.ignore)))
			return;
		end();
		const origin = { x: event.clientX, y: event.clientY };
		const press = new LongPress((at) => {
			if (finger) finger.state = "reject";
			resetPull(row);
			if (!spec.hold) return;
			swallow = true;
			if (typeof navigator.vibrate === "function") navigator.vibrate(10);
			spec.hold(row, at);
		});
		press.begin(origin.x, origin.y);
		finger = {
			id: event.pointerId,
			row,
			origin,
			press,
			swipes: !atScreenEdge(origin.x, window.innerWidth),
			state: "wait",
			offset: 0,
			pulled: 0,
			samples: [{ x: origin.x, t: event.timeStamp }],
		};
	};

	const onMove = (event: PointerEvent) => {
		if (!finger || finger.id !== event.pointerId) return;
		const { row } = finger;
		const dx = sign * (event.clientX - finger.origin.x);
		const dy = event.clientY - finger.origin.y;
		if (finger.state === "wait") {
			// A finger that wanders off the hold gives it up by itself.
			finger.press.move(event.clientX, event.clientY);
			const across = Math.abs(dx);
			if (!finger.swipes) return;
			if (across >= INTENT && across > AXIS_RATIO * Math.abs(dy)) {
				// The row follows a finger going its way; one going the other way is not ours.
				finger.state = dx > 0 ? "drag" : "reject";
				if (finger.state === "drag") {
					finger.press.cancel();
					row.style.transition = "none";
					if (spec.reveal) row.dataset.swiping = "";
					window.addEventListener("touchmove", keepScroll, {
						passive: false,
					});
				}
			} else if (Math.abs(dy) >= INTENT) finger.state = "reject";
			if (finger.state !== "drag") return;
		}
		if (finger.state !== "drag") return;
		const can = spec.can(row);
		const pulled = Math.max(0, dx - INTENT);
		const width = row.offsetWidth || 1;
		finger.pulled = pulled;
		finger.offset = !can
			? Math.min(RUBBER_MAX, pulled * 0.3)
			: spec.leaves
				? Math.min(pulled, width)
				: pullTravel(pulled);
		finger.samples.push({ x: event.clientX, t: event.timeStamp });
		row.style.transform = `translate3d(${sign * finger.offset}px, 0, 0)`;
		if (can) {
			const armed = spec.leaves
				? settles(finger.offset / width, 0)
				: finger.offset >= PULL_ARM;
			if (armed) row.dataset.armed = "";
			else delete row.dataset.armed;
			showReveal(row, true);
		}
	};

	const onUp = (event: PointerEvent) => {
		if (!finger || finger.id !== event.pointerId) return;
		const { row, state, offset, pulled, samples } = finger;
		const fired = finger.press.end();
		end();
		if (fired && spec.hold) swallow = true;
		if (state !== "drag") return;
		swallow = true;
		const width = row.offsetWidth || 1;
		const velocity = speedOf(samples, event.timeStamp, sign);
		const acts =
			spec.can(row) &&
			pulled > INTENT &&
			(spec.leaves
				? settles(offset / width, velocity)
				: offset >= PULL_ARM || settles(0, velocity));
		if (!acts || !spec.leaves) resetPull(row);
		if (acts) spec.act(row);
	};

	const onCancel = (event: PointerEvent) => {
		if (!finger || finger.id !== event.pointerId) return;
		const { row, state } = finger;
		end();
		if (state === "drag") resetPull(row);
	};

	const onClick = (event: MouseEvent) => {
		if (!swallow) return;
		swallow = false;
		event.preventDefault();
		event.stopPropagation();
	};

	// A link is dragged by the browser as an address; the swipe is ours.
	const onDragStart = (event: DragEvent) => {
		if (rowOf(event.target)) event.preventDefault();
	};

	root.addEventListener("pointerdown", onDown);
	root.addEventListener("pointermove", onMove);
	root.addEventListener("pointerup", onUp);
	root.addEventListener("pointercancel", onCancel);
	root.addEventListener("click", onClick, true);
	root.addEventListener("dragstart", onDragStart);
	return {
		get swallowing() {
			return swallow;
		},
		forget() {
			swallow = false;
		},
		cancelHold() {
			finger?.press.cancel();
		},
		detach() {
			end();
			disarm();
			root.removeEventListener("pointerdown", onDown);
			root.removeEventListener("pointermove", onMove);
			root.removeEventListener("pointerup", onUp);
			root.removeEventListener("pointercancel", onCancel);
			root.removeEventListener("click", onClick, true);
			root.removeEventListener("dragstart", onDragStart);
		},
	};
}
