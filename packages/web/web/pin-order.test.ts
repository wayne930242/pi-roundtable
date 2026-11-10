import { expect, test } from "bun:test";
import { pinBefore, type Slot, slotAt, slotShifts } from "./lib/pin-order.ts";

/** Four pins in a grid of three: A B C on the first row, D under A. */
const grid: Slot[] = [
	{ left: 0, top: 0, width: 80, height: 100 },
	{ left: 100, top: 0, width: 80, height: 100 },
	{ left: 200, top: 0, width: 80, height: 100 },
	{ left: 0, top: 120, width: 80, height: 100 },
];

test("the slot under the finger is the one whose middle is nearest, and far outside the pins there is none", () => {
	expect(slotAt(grid, 40, 50)).toBe(0);
	expect(slotAt(grid, 230, 40)).toBe(2);
	// Below C, where no pin stands, the nearest middle is still C's or D's.
	expect(slotAt(grid, 60, 200)).toBe(3);
	expect(slotAt(grid, 240, 300)).toBe(-1);
	expect(slotAt(grid, -60, 50)).toBe(-1);
	expect(slotAt([], 0, 0)).toBe(-1);
});

test("held over another slot, the pins between take the next slot over, across the row break too", () => {
	// A to D's slot: B, C and D each take the slot before theirs, D going up to C's row.
	expect(slotShifts(grid, 0, 3)).toEqual([
		{ dx: 0, dy: 0 },
		{ dx: -100, dy: 0 },
		{ dx: -100, dy: 0 },
		{ dx: 200, dy: -120 },
	]);
	// D to B's slot: B and C move on, C down to D's place.
	expect(slotShifts(grid, 3, 1)).toEqual([
		{ dx: 0, dy: 0 },
		{ dx: 100, dy: 0 },
		{ dx: -200, dy: 120 },
		{ dx: 0, dy: 0 },
	]);
	// Over its own slot nothing moves.
	expect(slotShifts(grid, 1, 1).every((one) => !one.dx && !one.dy)).toBe(true);
});

test("the place a pin lands names the pin it goes before, or the end", () => {
	const keys = ["A", "B", "C", "D"];
	expect(pinBefore(keys, "A", 3)).toBeNull();
	expect(pinBefore(keys, "A", 1)).toBe("C");
	expect(pinBefore(keys, "D", 0)).toBe("A");
	expect(pinBefore(keys, "D", 1)).toBe("B");
});
