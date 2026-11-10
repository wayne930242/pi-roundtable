// Where a dragged pin lands among the pins, as plain functions over measured slots, so the rules can
// be tested without a pointer. The pins lie in a grid or a row, so a slot is a rectangle, not a band;
// the DOM side (`pin-drag.ts`) measures, calls these, and paints.

/** A pin's place: its rectangle in px, in coordinates scrolling does not change. */
export interface Slot {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** How far outside the pins (px) a finger still counts as over them; further out, a drop cancels. */
export const PIN_SLACK = 48;

const middle = (slot: Slot) => ({
	x: slot.left + slot.width / 2,
	y: slot.top + slot.height / 2,
});

/**
 * The slot whose middle is nearest the finger at (`x`, `y`), or -1 when the finger is further than
 * `PIN_SLACK` outside every slot.
 */
export function slotAt(slots: readonly Slot[], x: number, y: number): number {
	if (slots.length === 0) return -1;
	const left = Math.min(...slots.map((one) => one.left));
	const top = Math.min(...slots.map((one) => one.top));
	const right = Math.max(...slots.map((one) => one.left + one.width));
	const bottom = Math.max(...slots.map((one) => one.top + one.height));
	if (
		x < left - PIN_SLACK ||
		x > right + PIN_SLACK ||
		y < top - PIN_SLACK ||
		y > bottom + PIN_SLACK
	)
		return -1;
	let best = 0;
	let nearest = Number.POSITIVE_INFINITY;
	slots.forEach((slot, i) => {
		const m = middle(slot);
		const d = Math.hypot(m.x - x, m.y - y);
		if (d < nearest) {
			nearest = d;
			best = i;
		}
	});
	return best;
}

/**
 * How far (`dx`, `dy`) each pin moves while the pin at `from` is held over slot `to`: every other
 * pin takes the slot of its place in the order the drop would make. The held pin itself is 0; it
 * follows the finger.
 */
export function slotShifts(
	slots: readonly Slot[],
	from: number,
	to: number,
): { dx: number; dy: number }[] {
	const order = slots.map((_, i) => i).filter((i) => i !== from);
	order.splice(to, 0, from);
	return slots.map((slot, i) => {
		if (i === from) return { dx: 0, dy: 0 };
		const goes = slots[order.indexOf(i)] ?? slot;
		return { dx: goes.left - slot.left, dy: goes.top - slot.top };
	});
}

/** The pin the dragged one goes before when it lands at index `to`; null for the end. */
export function pinBefore(
	keys: readonly string[],
	dragged: string,
	to: number,
): string | null {
	return keys.filter((key) => key !== dragged)[to] ?? null;
}
