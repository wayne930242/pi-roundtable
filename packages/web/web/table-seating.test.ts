import { expect, test } from "bun:test";
import {
	backOut,
	FADE_MS,
	GLIDE_MS,
	glideProgress,
	leavePose,
	PUFF_MS,
	planSeating,
	RISE_MS,
	risePose,
	SWAP_AFTER_PUFF_MS,
	turnToward,
	VANISH_MS,
} from "./table/seating";

const ring = ["a", "b", "c", "d"];

test("a seat that leaves puffs first, the others glide once it is hidden, and nothing rises", () => {
	const plan = planSeating(ring, ["a", "c", "d"], false);
	expect(plan.mode).toBe("play");
	expect(plan.leaving).toEqual(["b"]);
	expect(plan.joining).toEqual([]);
	expect(plan.staying).toEqual(["a", "c", "d"]);
	expect(plan.swapAt).toBe(SWAP_AFTER_PUFF_MS);
	expect(plan.swapAt).toBeGreaterThanOrEqual(VANISH_MS);
	expect(plan.glideEnd).toBe(plan.swapAt + GLIDE_MS);
	expect(plan.total).toBe(plan.glideEnd);
	// the puff itself is over before the glide is
	expect(PUFF_MS).toBeLessThanOrEqual(plan.total);
});

test("a seat that joins waits for the others to open the gap, then rises", () => {
	const plan = planSeating(["a", "c", "d"], ring, false);
	expect(plan.mode).toBe("play");
	expect(plan.joining).toEqual(["b"]);
	expect(plan.leaving).toEqual([]);
	// the ring is re-planned at once: nobody has to vanish first
	expect(plan.swapAt).toBe(0);
	expect(plan.glideEnd).toBe(GLIDE_MS);
	expect(plan.riseAt).toBe(plan.glideEnd);
	expect(plan.riseEnd).toBe(plan.riseAt + RISE_MS);
	expect(plan.total).toBe(plan.riseEnd);
});

test("one that leaves and one that joins play in order: puff, glide, rise", () => {
	const plan = planSeating(["a", "b"], ["a", "c"], false);
	expect(plan.leaving).toEqual(["b"]);
	expect(plan.joining).toEqual(["c"]);
	expect(plan.staying).toEqual(["a"]);
	expect(plan.swapAt).toBeLessThan(plan.glideEnd);
	expect(plan.glideEnd).toBeLessThanOrEqual(plan.riseAt);
	expect(plan.riseAt).toBeLessThan(plan.riseEnd);
});

test("the seats that change are read from the ids, in ring order, not from where they stand", () => {
	const plan = planSeating(["a", "b", "c"], ["c", "d", "a"], false);
	expect(plan.leaving).toEqual(["b"]);
	expect(plan.joining).toEqual(["d"]);
	expect(plan.staying).toEqual(["c", "a"]);
});

test("the same people in another order, or a rename, change the ring at once without a show", () => {
	for (const after of [["c", "b", "a"], ring]) {
		const plan = planSeating(
			["a", "b", "c", "d"].slice(0, after.length),
			after,
			false,
		);
		expect(plan.mode).toBe("cut");
		expect(plan.total).toBe(0);
	}
});

test("under reduced motion the picture dips and the ring changes while it is down: no smoke, no rise", () => {
	for (const [before, after] of [
		[ring, ["a", "c", "d"]],
		[["a", "c", "d"], ring],
	] as const) {
		const plan = planSeating(before, after, true);
		expect(plan.mode).toBe("fade");
		expect(plan.swapAt).toBe(FADE_MS);
		expect(plan.total).toBe(FADE_MS * 2);
		// it still names who left and who came, so the page can say so
		expect(plan.leaving.length + plan.joining.length).toBe(1);
	}
	// nothing changed in the set, nothing to fade
	expect(planSeating(ring, [...ring].reverse(), true).mode).toBe("cut");
});

test("a table that empties, or fills from nothing, is one puff per seat and one rise per seat", () => {
	const emptied = planSeating(["a", "b"], [], false);
	expect(emptied.leaving).toEqual(["a", "b"]);
	expect(emptied.total).toBe(emptied.glideEnd);
	const filled = planSeating([], ["a", "b"], false);
	expect(filled.joining).toEqual(["a", "b"]);
	expect(filled.riseAt).toBe(GLIDE_MS);
});

test("the whole show stays under two seconds", () => {
	const longest = planSeating(["a", "b"], ["a", "c"], false);
	expect(longest.total).toBeLessThanOrEqual(2000);
	expect(PUFF_MS).toBeGreaterThanOrEqual(600);
	expect(PUFF_MS).toBeLessThanOrEqual(800);
	expect(RISE_MS).toBeGreaterThanOrEqual(700);
	expect(RISE_MS).toBeLessThanOrEqual(900);
});

test("a leaving seat squashes, is hidden inside the clouds, and the clouds then drift and fade", () => {
	const start = leavePose(0);
	expect(start.scaleX).toBe(1);
	expect(start.scaleY).toBe(1);
	expect(start.gone).toBe(false);
	const squashed = leavePose(VANISH_MS / 2);
	expect(squashed.scaleY).toBeLessThan(1);
	expect(squashed.scaleX).toBeGreaterThan(1);
	expect(squashed.gone).toBe(false);
	expect(leavePose(VANISH_MS).gone).toBe(true);
	expect(leavePose(PUFF_MS / 2).puff).toBeCloseTo(0.5, 5);
	expect(leavePose(PUFF_MS * 3).puff).toBe(1);
});

test("a joining seat waits out of sight, the circle glows first, then it rises past its place and settles", () => {
	const waiting = risePose(-1);
	expect(waiting.shown).toBe(false);
	expect(waiting.circle).toBe(0);
	const glowing = risePose(RISE_MS * 0.15);
	expect(glowing.shown).toBe(false);
	expect(glowing.circle).toBeGreaterThan(0);
	const rising = risePose(RISE_MS * 0.35);
	expect(rising.shown).toBe(true);
	expect(rising.depth).toBeLessThan(1);
	expect(rising.depth).toBeGreaterThan(0);
	// the bounce: somewhere on the way it is above its place
	const lows = Array.from(
		{ length: 60 },
		(_, i) => risePose((RISE_MS * i) / 59).depth,
	);
	expect(Math.min(...lows)).toBeLessThan(0);
	const done = risePose(RISE_MS);
	expect(done.depth).toBeCloseTo(0, 5);
	expect(done.circle).toBe(0);
	expect(done.light).toBeCloseTo(0, 5);
	expect(risePose(RISE_MS * 5).depth).toBeCloseTo(0, 5);
});

test("a joining seat's name follows its podium: none while the others glide or the podium is out of sight, and it stays once the podium is up", () => {
	// the name is the page's, so it must never stand over a gap that no podium fills yet
	for (const ms of [-GLIDE_MS, -1]) expect(risePose(ms).named).toBe(false);
	let named = false;
	for (let step = 0; step <= 200; step += 1) {
		const pose = risePose((RISE_MS * 1.2 * step) / 200);
		// a name is only ever shown over a podium that is shown, and most of the way up
		if (pose.named) {
			expect(pose.shown).toBe(true);
			expect(pose.depth).toBeLessThanOrEqual(0.35);
		}
		// and once shown it stays, through the bounce and after
		if (named) expect(pose.named).toBe(true);
		named = named || pose.named;
	}
	expect(named).toBe(true);
	expect(risePose(RISE_MS).named).toBe(true);
	expect(risePose(RISE_MS * 0.25).named).toBe(false);
});

test("the glide is eased from 0 to 1, and a turn takes the shorter way round", () => {
	expect(glideProgress(0)).toBe(0);
	expect(glideProgress(GLIDE_MS)).toBe(1);
	expect(glideProgress(GLIDE_MS / 2)).toBeCloseTo(0.5, 5);
	expect(glideProgress(GLIDE_MS * 4)).toBe(1);
	expect(backOut(0)).toBeCloseTo(0, 5);
	expect(backOut(1)).toBeCloseTo(1, 5);
	// from just under π to just over -π is a short step, not a lap
	expect(turnToward(3, -3, 0.5)).toBeCloseTo(3 + (2 * Math.PI - 6) / 2, 5);
});
