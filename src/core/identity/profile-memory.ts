/** A map whose entries expire, holding at most `max`; the oldest goes first. Memory only. */
export class ExpiringMap<V> {
	readonly #entries = new Map<string, { value: V; until: number }>();
	readonly #max: number;

	constructor(max: number) {
		this.#max = max;
	}

	get(key: string, now: number): V | undefined {
		const entry = this.#entries.get(key);
		if (!entry) return undefined;
		if (entry.until <= now) {
			this.#entries.delete(key);
			return undefined;
		}
		return entry.value;
	}

	set(key: string, value: V, now: number, ttlMs: number): void {
		this.#entries.delete(key);
		this.#entries.set(key, { value, until: now + ttlMs });
		for (const old of this.#entries.keys()) {
			if (this.#entries.size <= this.#max) break;
			this.#entries.delete(old);
		}
	}

	delete(key: string): void {
		this.#entries.delete(key);
	}

	/** The summed `weight` of what is held, for a cache bounded by size. */
	weigh(weight: (value: V) => number): number {
		let total = 0;
		for (const entry of this.#entries.values()) total += weight(entry.value);
		return total;
	}

	/** Drops the oldest entry; false when there is none. */
	evictOldest(): boolean {
		for (const old of this.#entries.keys()) {
			this.#entries.delete(old);
			return true;
		}
		return false;
	}
}

const NAME_MAX = 80;

/**
 * A name a provider or a session reported, made safe to show and to give an agent: control and
 * invisible formatting characters become spaces, runs of space one, at most 80 characters.
 * Undefined when nothing is left.
 */
export function cleanName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value
		.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (text === "") return undefined;
	return [...text].slice(0, NAME_MAX).join("").trim() || undefined;
}
