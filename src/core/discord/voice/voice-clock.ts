/** The time a voice session cuts utterances and waits by; a test gives its own. */
export interface VoiceClock {
	/** Milliseconds since the epoch. */
	now(): number;
	setTimeout(run: () => void, ms: number): unknown;
	clearTimeout(timer: unknown): void;
}

/** The host's clock. */
export const systemClock: VoiceClock = {
	now: () => Date.now(),
	setTimeout: (run, ms) => setTimeout(run, ms),
	clearTimeout: (timer) => clearTimeout(timer as Timer),
};

/** A clock that moves only when told to, for a stand-in voice connection. */
export interface ManualVoiceClock extends VoiceClock {
	/** Moves the time on, running each timer that comes due at its own time, in order. */
	advance(ms: number): void;
}

/** A manual clock that starts at `start`, by default now. */
export function manualVoiceClock(start = Date.now()): ManualVoiceClock {
	let time = start;
	let next = 1;
	const timers = new Map<number, { at: number; run: () => void }>();
	return {
		now: () => time,
		setTimeout: (run, ms) => {
			timers.set(next, { at: time + Math.max(0, ms), run });
			return next++;
		},
		clearTimeout: (timer) => {
			if (typeof timer === "number") timers.delete(timer);
		},
		advance: (ms) => {
			const until = time + ms;
			for (;;) {
				let due: [number, { at: number; run: () => void }] | undefined;
				for (const entry of timers)
					if (entry[1].at <= until && (!due || entry[1].at < due[1].at))
						due = entry;
				if (!due) break;
				timers.delete(due[0]);
				time = due[1].at;
				due[1].run();
			}
			time = until;
		},
	};
}
