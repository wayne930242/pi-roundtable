// How a speaking figure's mouth moves: the same beat for the 3D standee (which swaps its board between
// the closed and the open picture) and the 2D one (which plays it as discrete frames).

/** About how many times a second a talking mouth opens and closes. */
export const TALK_HZ = 7;

/** A small, steady hash of an integer into [0, 1). */
const noise = (n: number): number => {
	const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
	return x - Math.floor(x);
};

/**
 * Whether a talking figure's mouth is open at `seconds`: it opens and closes about seven times a
 * second, now and then a beat held shut, so it reads as speech and not a metronome. `phase` keeps two
 * speakers out of step.
 */
export function mouthOpenAt(seconds: number, phase = 0): boolean {
	const beat = Math.floor(seconds * TALK_HZ * 2 + phase * 10);
	if (beat % 2 === 0) return false;
	return noise(beat) > 0.2;
}

/**
 * The same beat as `count` half-beat frames (1 open, 0 closed) that loop, for a figure drawn once and
 * animated by the browser; `seconds` is how long the loop lasts.
 */
export function talkFrames(
	phase = 0,
	count = 28,
): { frames: number[]; seconds: number } {
	const half = 1 / (TALK_HZ * 2);
	const frames = Array.from({ length: count }, (_, at) =>
		mouthOpenAt((at + 0.5) * half, phase) ? 1 : 0,
	);
	return { frames, seconds: count * half };
}
