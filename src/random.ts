/** Returns a number from 0 up to, not including, 1, like `Math.random`. */
export type Random = () => number;

/** A seed for Rough.js, which treats 0 as "pick one yourself"; always in 1 to 2^31 - 2. */
export function roughSeed(random: Random): number {
	return 1 + Math.floor(random() * 0x7ffffffe);
}

/** A small deterministic generator for tests and reproducible drawings (mulberry32). */
export function seededRandom(seed: number): Random {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
