import { type Clock, LongPress } from "../lib/long-press.ts";
import type { SeatMenuRequest } from "./types";

/**
 * Gives the table's seats the page's menu gestures: a finger that rests on a seat, a right click and
 * the Menu key (or Shift+F10) on a seat's name. `seatAt` says which seat a press is on, if any. A
 * hold ends with a lift whose click is swallowed, so the seat does not also open. A mouse never
 * holds: it has the right button.
 */
export function attachSeatMenu(
	root: HTMLElement,
	seatAt: (
		target: EventTarget | null,
		x: number,
		y: number,
	) => { id: string; name: string } | undefined,
	open: (request: SeatMenuRequest) => void,
	clock?: Clock,
): () => void {
	let press: LongPress | undefined;
	let pointer = -1;
	/** A hold opened the menu; the click that follows the lift must not open the seat. */
	let swallow = false;
	const sourceOf = (target: EventTarget | null): HTMLElement =>
		target instanceof Element
			? (target.closest<HTMLElement>("button, [data-seat]") ?? root)
			: root;

	const drop = () => {
		press?.cancel();
		press = undefined;
		pointer = -1;
	};
	const onDown = (event: PointerEvent) => {
		swallow = false;
		if (event.pointerType === "mouse" || !event.isPrimary) return;
		drop();
		const seat = seatAt(event.target, event.clientX, event.clientY);
		if (!seat) return;
		const source = sourceOf(event.target);
		pointer = event.pointerId;
		press = new LongPress((at) => {
			swallow = true;
			if (typeof navigator.vibrate === "function") navigator.vibrate(10);
			open({ ...seat, at, via: "hold", source });
		}, clock);
		press.begin(event.clientX, event.clientY);
	};
	const onMove = (event: PointerEvent) => {
		if (event.pointerId === pointer && press && !swallow)
			if (!press.move(event.clientX, event.clientY)) drop();
	};
	const onEnd = (event: PointerEvent) => {
		if (event.pointerId === pointer) drop();
	};
	const onContextMenu = (event: MouseEvent) => {
		const seat = seatAt(event.target, event.clientX, event.clientY);
		if (!seat) return;
		event.preventDefault();
		// Android fires this after the hold that already opened the menu.
		if (swallow) return;
		drop();
		open({
			...seat,
			at: { x: event.clientX, y: event.clientY },
			via: "contextmenu",
			source: sourceOf(event.target),
		});
	};
	const onKey = (event: KeyboardEvent) => {
		swallow = false;
		if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey))
			return;
		const seat = seatAt(event.target, -1, -1);
		if (!seat) return;
		event.preventDefault();
		const source = sourceOf(event.target);
		const box = source.getBoundingClientRect();
		open({
			...seat,
			at: { x: box.left + Math.min(box.width / 2, 48), y: box.top + 24 },
			via: "key",
			source,
		});
	};
	const onClick = (event: MouseEvent) => {
		if (!swallow) return;
		swallow = false;
		event.preventDefault();
		event.stopPropagation();
	};

	root.addEventListener("pointerdown", onDown);
	root.addEventListener("pointermove", onMove);
	root.addEventListener("pointerup", onEnd);
	root.addEventListener("pointercancel", onEnd);
	root.addEventListener("contextmenu", onContextMenu);
	root.addEventListener("keydown", onKey);
	root.addEventListener("click", onClick, true);
	return () => {
		drop();
		root.removeEventListener("pointerdown", onDown);
		root.removeEventListener("pointermove", onMove);
		root.removeEventListener("pointerup", onEnd);
		root.removeEventListener("pointercancel", onEnd);
		root.removeEventListener("contextmenu", onContextMenu);
		root.removeEventListener("keydown", onKey);
		root.removeEventListener("click", onClick, true);
	};
}
