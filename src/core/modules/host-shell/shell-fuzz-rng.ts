/** A small seeded random source, so a generated line can be rebuilt from its seed alone (mulberry32). */
export class Rng {
	#state: number;

	constructor(seed: number) {
		this.#state = seed >>> 0;
	}

	/** A number in [0, 1). */
	next(): number {
		this.#state = (this.#state + 0x6d2b79f5) >>> 0;
		let t = this.#state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}

	/** An integer in [0, n). */
	int(n: number): number {
		return Math.floor(this.next() * n);
	}

	chance(p: number): boolean {
		return this.next() < p;
	}

	pick<T>(items: readonly T[]): T {
		return items[this.int(items.length)] as T;
	}

	/** One item, chosen with the odds of its weight. */
	weighted<T>(entries: ReadonlyArray<readonly [number, T]>): T {
		let total = 0;
		for (const [weight] of entries) total += weight;
		let at = this.next() * total;
		for (const [weight, item] of entries) {
			at -= weight;
			if (at < 0) return item;
		}
		return (entries[entries.length - 1] as readonly [number, T])[1];
	}
}

/** `text` as one single-quoted word. */
export const singleQuote = (text: string): string =>
	`'${text.replaceAll("'", `'\\''`)}'`;

/** `text` as one double-quoted word that expands to exactly `text` when read as a script. */
export const doubleQuote = (text: string): string =>
	`"${text.replace(/[\\"$`]/g, "\\$&")}"`;

/** `text` as one `$'…'` word. */
export const ansiQuote = (text: string): string =>
	`$'${text.replace(/[\\']/g, "\\$&").replaceAll("\n", "\\n")}'`;

/** `text` with every character that is special to the shell escaped by a backslash. */
export const backslashQuote = (text: string): string =>
	text.replace(/[^A-Za-z0-9_./=-]/g, (ch) =>
		ch === "\n" ? "'\n'" : `\\${ch}`,
	);

/** `text` as the body of a backtick substitution: its own backslashes and backticks escaped. */
export const backtickBody = (text: string): string =>
	text.replace(/[\\`]/g, "\\$&");
