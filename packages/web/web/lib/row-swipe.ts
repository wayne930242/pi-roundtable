// The swipe to the right that a row of a list answers: a dispatch thread's card clears itself, a room's
// row marks the room read. This holds how a finger is told from a scroll, a tap and a hold, how far the
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
/** The last stretch of the drag (ms) that the finger's speed is read from. */
const SPEED_WINDOW_MS = 100;

/** What a list's rows do under a swipe to the right. */
export interface RowSwipeSpec {
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
	samples: { x: number; t: number }[];
}

const keepScroll = (event: TouchEvent) => {
	if (event.cancelable) event.preventDefault();
};

/** How fast (px per ms) the finger was going to the right when it lifted at `at`. */
function speedOf(samples: Finger["samples"], at: number): number {
	const last = samples.at(-1);
	if (!last || at - last.t > SPEED_WINDOW_MS) return 0;
	const first = samples.find((one) => last.t - one.t <= SPEED_WINDOW_MS);
	if (!first || last.t <= first.t) return 0;
	return (last.x - first.x) / (last.t - first.t);
}

/**
 * Gives the rows inside `root` the swipe of `spec`. A row that can act follows a finger to the right
 * and acts when it is let go past 40 % of its width, or flicked; one that cannot only gives a little
 * and comes back. A swipe to the left, a scroll, an edge swipe and a hold are not the swipe.
 */
export function attachRowSwipe(
	root: HTMLElement,
	spec: RowSwipeSpec,
): RowSwipe {
	const disarm = armTouches();
	let finger: Finger | undefined;
	/** A swipe or a hold happened: the click that follows the lift must not open the row. */
	let swallow = false;

	const rowOf = (target: EventTarget | null): HTMLElement | null =>
		target instanceof Element ? target.closest<HTMLElement>(spec.row) : null;

	const showReveal = (row: HTMLElement, shown: boolean) => {
		const reveal = spec.reveal?.(row);
		if (!reveal) return;
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
			samples: [{ x: origin.x, t: event.timeStamp }],
		};
	};

	const onMove = (event: PointerEvent) => {
		if (!finger || finger.id !== event.pointerId) return;
		const { row } = finger;
		const dx = event.clientX - finger.origin.x;
		const dy = event.clientY - finger.origin.y;
		if (finger.state === "wait") {
			// A finger that wanders off the hold gives it up by itself.
			finger.press.move(event.clientX, event.clientY);
			const across = Math.abs(dx);
			if (!finger.swipes) return;
			if (across >= INTENT && across > AXIS_RATIO * Math.abs(dy)) {
				// The row follows a finger going right; one going left is not ours.
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
		finger.offset = can
			? Math.min(pulled, width)
			: Math.min(RUBBER_MAX, pulled * 0.3);
		finger.samples.push({ x: event.clientX, t: event.timeStamp });
		row.style.transform = `translate3d(${finger.offset}px, 0, 0)`;
		if (can) {
			showReveal(row, true);
			if (settles(finger.offset / width, 0)) row.dataset.armed = "";
			else delete row.dataset.armed;
		}
	};

	const onUp = (event: PointerEvent) => {
		if (!finger || finger.id !== event.pointerId) return;
		const { row, state, offset, samples } = finger;
		const fired = finger.press.end();
		end();
		if (fired && spec.hold) swallow = true;
		if (state !== "drag") return;
		swallow = true;
		const width = row.offsetWidth || 1;
		const velocity = speedOf(samples, event.timeStamp);
		const acts =
			spec.can(row) && offset > INTENT && settles(offset / width, velocity);
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
