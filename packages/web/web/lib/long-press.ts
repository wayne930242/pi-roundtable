// The long press that opens an action menu: a hold of a finger, a right click, or the Menu key.
// `LongPress` is the hold as a small state machine, so its timing can be tested with a clock the
// test moves by hand; `useLongPress` wires the three ways in to an element.

import {
	type KeyboardEvent,
	type MouseEvent,
	type PointerEvent,
	useRef,
} from "react";

/** How long a finger rests before the menu opens. */
export const HOLD_MS = 450;
/** How far the finger may wander (px) and still be holding. */
export const MOVE_LIMIT = 10;

export interface Point {
	x: number;
	y: number;
}

/** How the menu was asked for. */
export type Via = "hold" | "contextmenu" | "key";

/** What the hold needs from timers: `set` runs `run` after `ms` and returns what stops it. */
export interface Clock {
	set(run: () => void, ms: number): () => void;
}

const systemClock: Clock = {
	set: (run, ms) => {
		const timer = setTimeout(run, ms);
		return () => clearTimeout(timer);
	},
};

/** One finger's hold: `fire` runs once when it has rested for `HOLD_MS` without wandering. */
export class LongPress {
	readonly #fire: (at: Point) => void;
	readonly #clock: Clock;
	#origin: Point | undefined;
	#stop: (() => void) | undefined;
	#fired = false;

	constructor(fire: (at: Point) => void, clock: Clock = systemClock) {
		this.#fire = fire;
		this.#clock = clock;
	}

	/** The finger is down at (x, y). */
	begin(x: number, y: number): void {
		this.cancel();
		this.#fired = false;
		const origin = { x, y };
		this.#origin = origin;
		this.#stop = this.#clock.set(() => {
			this.#stop = undefined;
			this.#fired = true;
			this.#fire(origin);
		}, HOLD_MS);
	}

	/** The finger moved; false once it has wandered too far to be holding. */
	move(x: number, y: number): boolean {
		const origin = this.#origin;
		if (!origin || !this.#stop) return this.pending;
		if (Math.hypot(x - origin.x, y - origin.y) > MOVE_LIMIT) {
			this.cancel();
			return false;
		}
		return true;
	}

	/** The finger lifted; whether the hold had fired. */
	end(): boolean {
		const fired = this.#fired;
		this.cancel();
		return fired;
	}

	/** Gives the hold up (a scroll, a second finger, the browser taking over). */
	cancel(): void {
		this.#stop?.();
		this.#stop = undefined;
		this.#origin = undefined;
	}

	get pending(): boolean {
		return this.#stop !== undefined;
	}

	get fired(): boolean {
		return this.#fired;
	}
}

/** What the menu is asked to open with. */
export interface PressRequest {
	at: Point;
	via: Via;
	/** The element the press belongs to, which gets focus back when the menu closes. */
	source: HTMLElement;
}

/** The events one press went through already, so an inner target's menu is not followed by an outer one. */
const claimed = new WeakSet<Event>();
const claim = (event: Event): boolean => {
	if (claimed.has(event)) return false;
	claimed.add(event);
	return true;
};

const FIELD = "input, textarea, select, [contenteditable]";

const isMenuKey = (event: KeyboardEvent): boolean =>
	event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);

/** The props to spread on the element that opens a menu. */
export interface PressProps {
	"data-hold": "row" | "text";
	onPointerDown(event: PointerEvent<HTMLElement>): void;
	onPointerMove(event: PointerEvent<HTMLElement>): void;
	onPointerUp(event: PointerEvent<HTMLElement>): void;
	onPointerCancel(event: PointerEvent<HTMLElement>): void;
	onContextMenu(event: MouseEvent<HTMLElement>): void;
	onKeyDown(event: KeyboardEvent<HTMLElement>): void;
	onClickCapture(event: MouseEvent<HTMLElement>): void;
}

/**
 * A touch that rests 450 ms (and moves under 10 px, and does not scroll), a right click and a
 * Menu key or Shift+F10 all open the menu through `open`. Android fires `contextmenu` after its own
 * long press, which is answered once; iOS never does, so the hold is the way in there. A hold ends
 * with a lift, whose click is swallowed so a row does not also open. `selectable` marks text that
 * keeps its selection (a message); other targets are not selectable, so a hold does not start one.
 */
export function useLongPress(
	open: (request: PressRequest) => void,
	options: { selectable?: boolean } = {},
): PressProps {
	const latest = useRef(open);
	latest.current = open;
	const state = useRef<{
		press: LongPress;
		pointer: number;
		source: HTMLElement;
		stop(): void;
	}>(undefined);
	/** A hold opened the menu; the click that follows the lift must not act on the row. */
	const swallow = useRef(false);

	const drop = () => {
		state.current?.press.cancel();
		state.current?.stop();
		state.current = undefined;
	};

	return {
		"data-hold": options.selectable ? "text" : "row",
		onPointerDown(event) {
			swallow.current = false;
			if (event.pointerType === "mouse") return;
			if (!event.isPrimary || !claim(event.nativeEvent)) return;
			if (event.target instanceof Element && event.target.closest(FIELD))
				return;
			drop();
			const source = event.currentTarget;
			const press = new LongPress((at) => {
				swallow.current = true;
				if (typeof navigator.vibrate === "function") navigator.vibrate(10);
				latest.current({ at, via: "hold", source });
			});
			// A scroll anywhere takes the touch from us.
			const cancel = () => drop();
			window.addEventListener("scroll", cancel, true);
			state.current = {
				press,
				pointer: event.pointerId,
				source,
				stop: () => window.removeEventListener("scroll", cancel, true),
			};
			press.begin(event.clientX, event.clientY);
		},
		onPointerMove(event) {
			const current = state.current;
			if (!current || current.pointer !== event.pointerId) return;
			if (!current.press.move(event.clientX, event.clientY) && !swallow.current)
				drop();
		},
		onPointerUp(event) {
			if (state.current?.pointer === event.pointerId) drop();
		},
		onPointerCancel(event) {
			if (state.current?.pointer === event.pointerId) drop();
		},
		onContextMenu(event) {
			if (!claim(event.nativeEvent)) return;
			event.preventDefault();
			// Android fires this after the hold that already opened the menu.
			if (swallow.current) return;
			drop();
			latest.current({
				at: { x: event.clientX, y: event.clientY },
				via: "contextmenu",
				source: event.currentTarget,
			});
		},
		onKeyDown(event) {
			swallow.current = false;
			if (!isMenuKey(event) || !claim(event.nativeEvent)) return;
			event.preventDefault();
			const box = event.currentTarget.getBoundingClientRect();
			latest.current({
				at: { x: box.left + Math.min(box.width / 2, 48), y: box.top + 24 },
				via: "key",
				source: event.currentTarget,
			});
		},
		onClickCapture(event) {
			if (!swallow.current) return;
			swallow.current = false;
			event.preventDefault();
			event.stopPropagation();
		},
	};
}
