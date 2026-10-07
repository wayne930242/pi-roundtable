/** Turns one conversation may hold at once: the running one and one queued behind it. */
export const TURNS_PER_CONVERSATION = 2;

/**
 * The turns each person has running or queued, by conversation. A person holds at most
 * `perPrincipal` across their conversations, and a conversation at most `TURNS_PER_CONVERSATION`,
 * so one person cannot keep the shared model busy with many turns at once.
 */
export class TurnBudget {
	readonly #perPrincipal: number;
	readonly #held = new Map<string, Map<string, number>>();

	constructor(perPrincipal: number) {
		this.#perPrincipal = perPrincipal;
	}

	/** Whether the person may start one more turn, in `conversation` when it is named. */
	allows(principal: string, conversation?: string): boolean {
		const mine = this.#held.get(principal);
		let total = 0;
		for (const count of mine?.values() ?? []) total += count;
		if (total >= this.#perPrincipal) return false;
		return (
			conversation === undefined ||
			(mine?.get(conversation) ?? 0) < TURNS_PER_CONVERSATION
		);
	}

	/** Takes a place for one turn: a function that frees it, once, or undefined over a limit. */
	take(principal: string, conversation: string): (() => void) | undefined {
		if (!this.allows(principal, conversation)) return undefined;
		const mine = this.#held.get(principal) ?? new Map<string, number>();
		mine.set(conversation, (mine.get(conversation) ?? 0) + 1);
		this.#held.set(principal, mine);
		let held = true;
		return () => {
			if (!held) return;
			held = false;
			const left = (mine.get(conversation) ?? 1) - 1;
			if (left > 0) mine.set(conversation, left);
			else mine.delete(conversation);
			if (mine.size === 0) this.#held.delete(principal);
		};
	}
}

/** At most `limit` events per key in any `perMs` window, as a log of each key's recent events. */
export class RateWindow {
	readonly #limit: number;
	readonly #perMs: number;
	readonly #now: () => number;
	readonly #events = new Map<string, number[]>();

	constructor(limit: number, perMs: number, now: () => number) {
		this.#limit = limit;
		this.#perMs = perMs;
		this.#now = now;
	}

	/** Records one event for `key`; false, recording nothing, when the window is full. */
	take(key: string): boolean {
		const now = this.#now();
		const recent = (this.#events.get(key) ?? []).filter(
			(at) => at > now - this.#perMs,
		);
		if (recent.length >= this.#limit) {
			this.#events.set(key, recent);
			return false;
		}
		recent.push(now);
		this.#events.set(key, recent);
		return true;
	}
}
