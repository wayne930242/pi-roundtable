/** How long a shutdown waits for running work before aborting it (self-maintenance spec behavior 11). */
export const DRAIN_LIMIT_MS = 60 * 60_000;

export interface DrainOptions {
	/** What still runs or waits, one entry per piece of work; empty when idle. */
	busy: () => string[];
	limitMs?: number;
	intervalMs?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

/**
 * Waits until nothing runs or waits, checking every interval, for at most the limit. Work that
 * arrives meanwhile is served as usual and waited for too. Returns what was still busy when the
 * limit ran out, or an empty list once idle.
 */
export async function waitUntilIdle(options: DrainOptions): Promise<string[]> {
	const {
		busy,
		limitMs = DRAIN_LIMIT_MS,
		intervalMs = 1_000,
		sleep = (ms) => Bun.sleep(ms),
		now = Date.now,
	} = options;
	const deadline = now() + limitMs;
	for (;;) {
		const left = busy();
		if (left.length === 0) return [];
		if (now() >= deadline) return left;
		await sleep(intervalMs);
	}
}
