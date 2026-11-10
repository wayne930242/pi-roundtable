// The lifted pin: it follows the finger across the grid or the dock, the other pins move over to
// make room, and the dock scrolls near its ends. Loaded on the first lift of a pin only. The
// decisions (where a drop lands) are `pin-order.ts`; this file measures and paints.

import { installArrangedStyle } from "./arranged-style.ts";
import { type Lift, REST_MS, resisted } from "./drag.ts";
import { setLifting } from "./lifting.ts";
import { MOVE_LIMIT } from "./long-press.ts";
import { reducedMotion } from "./motion.ts";
import { pinBefore, type Slot, slotAt, slotShifts } from "./pin-order.ts";
import { scrollStep } from "./reorder.ts";

/** Lifts the pin and follows the finger until it lets go; returns what stops the lift early. */
export function liftPin(options: Lift): () => void {
	installArrangedStyle();
	const { item, root, key } = options;
	const pins = [
		...root.querySelectorAll<HTMLElement>(":scope > [data-pin-item]"),
	];
	const keys = pins.map((one) => one.dataset.key ?? "");
	const from = keys.indexOf(key);
	/** Client x → x along the dock's content, which scrolling the dock does not change. */
	const along = (clientX: number) => clientX + root.scrollLeft;
	const slots: Slot[] = pins.map((one) => {
		const rect = one.getBoundingClientRect();
		return {
			left: along(rect.left),
			top: rect.top,
			width: rect.width,
			height: rect.height,
		};
	});

	setLifting(true);
	item.setAttribute("data-lifted", "");
	root.setAttribute("data-reordering", "");
	const wiggles = !reducedMotion();
	if (wiggles) item.setAttribute("data-resting", "");
	let rest: ReturnType<typeof setTimeout> | undefined;
	if (typeof navigator.vibrate === "function") navigator.vibrate(10);

	const start = { x: along(options.x ?? 0), y: options.y };
	let at = { x: options.x ?? 0, y: options.y };
	let moved = false;
	let frame = 0;
	let result: { before: string | null } | undefined;

	try {
		item.setPointerCapture(options.pointerId);
	} catch {
		// The window listeners below still follow the finger.
	}

	const paint = () => {
		frame = 0;
		const x = along(at.x);
		const dx = x - start.x;
		const dy = at.y - start.y;
		const travel = Math.hypot(dx, dy);
		if (travel > MOVE_LIMIT) moved = true;
		// The pull is held back by its length, so a diagonal move is damped like a straight one.
		const scale = travel === 0 ? 1 : resisted(travel) / travel;
		item.style.transform = `translate3d(${dx * scale}px, ${dy * scale}px, 0)`;
		const to = slotAt(slots, x, at.y);
		result =
			to < 0 || to === from ? undefined : { before: pinBefore(keys, key, to) };
		const move = slotShifts(slots, from, to < 0 ? from : to);
		pins.forEach((one, i) => {
			if (one === item) return;
			const shift = move[i] ?? { dx: 0, dy: 0 };
			one.style.transform =
				shift.dx || shift.dy
					? `translate3d(${shift.dx}px, ${shift.dy}px, 0)`
					: "";
		});
		// The dock scrolls near its ends, and the lifted pin keeps following the finger.
		if (root.scrollWidth > root.clientWidth) {
			const box = root.getBoundingClientRect();
			const step = scrollStep(at.x, box.left, box.right, 40, 12);
			if (step) {
				const before = root.scrollLeft;
				root.scrollLeft += step;
				if (root.scrollLeft !== before) schedule();
			}
		}
	};
	const schedule = () => {
		if (!frame) frame = requestAnimationFrame(paint);
	};

	const end = (outcome: Parameters<Lift["done"]>[0]) => {
		cleanup();
		options.done(outcome);
	};
	const mine = (event: PointerEvent) => event.pointerId === options.pointerId;
	const onMove = (event: PointerEvent) => {
		if (!mine(event)) return;
		event.stopPropagation();
		event.preventDefault();
		if (wiggles && (event.clientX !== at.x || event.clientY !== at.y)) {
			item.removeAttribute("data-resting");
			if (rest) clearTimeout(rest);
			rest = setTimeout(() => item.setAttribute("data-resting", ""), REST_MS);
		}
		at = { x: event.clientX, y: event.clientY };
		schedule();
	};
	const onUp = (event: PointerEvent) => {
		if (!mine(event)) return;
		event.stopPropagation();
		if (frame) {
			cancelAnimationFrame(frame);
			paint();
		}
		if (!moved) return end({ type: "tap" });
		end(result ? { type: "pin", before: result.before } : { type: "cancel" });
	};
	const onCancel = (event: PointerEvent) => {
		if (mine(event)) end({ type: "cancel" });
	};
	const onKey = (event: KeyboardEvent) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		end({ type: "cancel" });
	};
	const hold = (event: Event) => event.preventDefault();
	function cleanup() {
		setLifting(false);
		window.removeEventListener("pointermove", onMove, true);
		window.removeEventListener("pointerup", onUp, true);
		window.removeEventListener("pointercancel", onCancel, true);
		window.removeEventListener("keydown", onKey, true);
		window.removeEventListener("touchmove", hold, true);
		window.removeEventListener("contextmenu", hold, true);
		if (frame) cancelAnimationFrame(frame);
		if (rest) clearTimeout(rest);
		item.removeAttribute("data-resting");
		item.removeAttribute("data-lifted");
		root.removeAttribute("data-reordering");
		for (const one of pins) one.style.removeProperty("transform");
		try {
			item.releasePointerCapture(options.pointerId);
		} catch {
			// It was not captured.
		}
	}
	window.addEventListener("pointermove", onMove, true);
	window.addEventListener("pointerup", onUp, true);
	window.addEventListener("pointercancel", onCancel, true);
	window.addEventListener("keydown", onKey, true);
	// The page must not scroll under the finger once a pin is lifted.
	window.addEventListener("touchmove", hold, { capture: true, passive: false });
	window.addEventListener("contextmenu", hold, true);
	schedule();
	return () => end({ type: "cancel" });
}
