/** What `admit` finds: the key is held, its group is full, or the alert may go. */
export type Admission = "open" | "repeat" | "full";

export interface AlertThrottleOptions {
	/** How long a key, and a slot of its group, is held. */
	windowMs: number;
	/** The most slots one group holds inside the window. */
	groupCap: number;
	now: () => number;
}

/**
 * The rolling window behind the error reports and the ops alerts: a key is held for a window, and
 * a group of keys has a fixed number of slots inside it. Nothing here posts or schedules; the
 * caller asks, then holds and takes a slot in the same synchronous step, so two alerts raised
 * together for one key go out once.
 */
export class AlertThrottle {
	readonly #windowMs: number;
	readonly #groupCap: number;
	readonly #now: () => number;
	readonly #held = new Map<string, number>();
	/** The times each group took a slot inside the window, oldest first. */
	readonly #slots = new Map<string, number[]>();

	constructor(options: AlertThrottleOptions) {
		this.#windowMs = options.windowMs;
		this.#groupCap = options.groupCap;
		this.#now = options.now;
	}

	/** "repeat" when the key is held, else "full" when the group is (unless `uncapped`), else "open". */
	admit(key: string, group: string, uncapped = false): Admission {
		const now = this.#now();
		this.#pruneKeys(now);
		if (this.#held.has(key)) return "repeat";
		if (!uncapped && this.#live(group, now).length >= this.#groupCap)
			return "full";
		return "open";
	}

	/** Holds the key for a window. */
	hold(key: string): void {
		this.#held.set(key, this.#now());
	}

	/** Takes one slot of the group for a window. */
	slot(group: string): void {
		const now = this.#now();
		this.#live(group, now).push(now);
	}

	/** Gives back the key and the group's newest slot (a post that failed). */
	release(key: string, group?: string): void {
		this.#held.delete(key);
		if (group !== undefined) this.#slots.get(group)?.pop();
	}

	/** When the group's oldest slot leaves the window; undefined while it has room. */
	roomAt(group: string): number | undefined {
		const slots = this.#live(group, this.#now());
		const oldest = slots[0];
		return slots.length >= this.#groupCap && oldest !== undefined
			? oldest + this.#windowMs
			: undefined;
	}

	#pruneKeys(now: number): void {
		for (const [key, at] of this.#held)
			if (now - at >= this.#windowMs) this.#held.delete(key);
	}

	/** The group's slots still inside the window; the array is kept. */
	#live(group: string, now: number): number[] {
		const live = (this.#slots.get(group) ?? []).filter(
			(at) => now - at < this.#windowMs,
		);
		this.#slots.set(group, live);
		return live;
	}
}
