import type { Tier } from "../speakers.ts";

/** How often being seen is written for one principal, unless the tier changes. */
const TOUCH_MS = 5 * 60_000;

/** What was last written for one principal. */
interface Seen {
	at: number;
	/** The tier written, null for a refusal. */
	tier: Tier | null;
	/** When they last came back from a refusal. */
	back?: number;
	/** Until when they are held at no tier for being refused and served by turns. */
	flapping?: number;
}

/**
 * When being seen is written for each principal: at most every `TOUCH_MS` at the same tier, at
 * once when the tier changes, and a refusal whenever the store still holds a tier for them.
 * Someone refused and served by turns, such as by the roles of two Discord servers, is held at
 * no tier for `TOUCH_MS` instead of being written at every message.
 */
export class SeenThrottle {
	readonly #seen = new Map<string, Seen>();

	/**
	 * Whether to write the principal as seen at `tier` now, recording it as written when so.
	 * `stored` says the store holds what a write would leave, as far as the caller knows.
	 */
	take(
		principalId: string,
		tier: Tier | null,
		now: number,
		stored: boolean,
	): boolean {
		const last = this.#seen.get(principalId);
		if (last && last.tier === tier && now - last.at < TOUCH_MS && stored)
			return false;
		if (tier !== null && last?.tier === null && now < (last.flapping ?? 0))
			return false;
		const back = tier !== null && last?.tier === null ? now : last?.back;
		const flapping =
			tier === null && back !== undefined && now - back < TOUCH_MS
				? now + TOUCH_MS
				: undefined;
		const seen: Seen = { at: now, tier };
		if (back !== undefined) seen.back = back;
		if (flapping !== undefined) seen.flapping = flapping;
		this.#seen.set(principalId, seen);
		return true;
	}

	/** Forgets what was written for the principal, such as after a write that failed. */
	forget(principalId: string): void {
		this.#seen.delete(principalId);
	}
}
