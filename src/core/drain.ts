import type { Logger } from "./log.ts";

/**
 * How long a shutdown waits for running work before aborting it: long enough for a usual turn to
 * answer, short enough that a hung one never holds a restart for an hour.
 */
export const DRAIN_LIMIT_MS = 3 * 60_000;

/** How long work that was told to stop gets to end before the shutdown goes on without it. */
const ABORT_GRACE_MS = 10_000;

export interface DrainOptions {
	/** What still runs or waits, one entry per piece of work; empty when idle. */
	busy: () => string[];
	/** The most the drain waits for running work; DRAIN_LIMIT_MS by default. */
	limitMs?: number;
	/** How often it looks again; one second by default. */
	intervalMs?: number;
	/** The most work told to stop at the limit gets to end; ABORT_GRACE_MS by default. */
	abortGraceMs?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

/**
 * Waits until nothing runs or waits, checking every interval, for at most the limit. Returns what
 * was still busy when the limit ran out, or an empty list once idle. It only waits: the host stops
 * work from starting before it calls this, and a caller that does not must expect work that
 * arrives meanwhile to be waited for too.
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

/**
 * Waits for running work up to the limit; if some is left, tells it to stop (`abort` says whether
 * it told any) and gives it the abort grace to end. Returns what the limit ran out on, even when stopping it worked, so the
 * caller can hand it over as cut short.
 */
export async function drainWork(
	options: DrainOptions & { abort: (left: string[]) => boolean },
): Promise<string[]> {
	const { abort, abortGraceMs = ABORT_GRACE_MS, ...waiting } = options;
	const left = await waitUntilIdle(waiting);
	if (left.length === 0) return left;
	// Work nothing could be told to stop would only be waited for in vain.
	if (abort(left)) await waitUntilIdle({ ...waiting, limitMs: abortGraceMs });
	return left;
}

/**
 * Tells each channel's running turn to stop, as the owner's stop does; a failure is logged and the
 * rest are still told. Whether any turn was running to be told.
 */
export function stopTurns(
	channels: readonly string[],
	stop: (channel: string) => boolean,
	logger: Logger,
): boolean {
	let stopped = false;
	for (const channel of new Set(channels)) {
		try {
			const told = stop(channel);
			logger.warn({ channel, told }, "stopping the turn");
			stopped ||= told;
		} catch (error) {
			logger.error({ channel, err: error }, "the turn could not be stopped");
		}
	}
	return stopped;
}
