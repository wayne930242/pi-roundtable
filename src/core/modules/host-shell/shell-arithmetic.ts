/**
 * The `((` groups of one list the lexer reads. Words in arithmetic are no commands, but `((a); (b))`
 * is two subshells, so the commands read inside an open group are kept apart and dropped only once
 * the group closes as `))`; any group left open or closed otherwise passes them on.
 */

/** A `((` that may be arithmetic: where it opened and how many commands were read before it. */
interface Group {
	depth: number;
	pos: number;
	start: number;
	/** Set when the `)` behind its closing one proved the group arithmetic. */
	confirmed: boolean;
}

export class ArithGroups {
	readonly #groups: Group[] = [];
	readonly #held: string[][] = [];

	/**
	 * @param out where commands go when they are not in arithmetic
	 * @param lone whether the list starts inside `$(`, so its first `(` is the second of `$((`
	 * @param listStart where the list starts
	 */
	constructor(
		readonly out: string[][],
		readonly src: string,
		readonly listStart: number,
		readonly lone: boolean,
	) {}

	/** Whether a command read now is inside a `((` group. */
	get open(): boolean {
		return this.#groups.length > 0;
	}

	/** A finished simple command: held while a group is open, else passed on. */
	add(words: string[]) {
		(this.open ? this.#held : this.out).push(words);
	}

	/** The `(` at `pos`, at paren depth `depth`, opens a group. */
	push(depth: number, pos: number) {
		this.#groups.push({
			depth,
			pos,
			start: this.#held.length,
			confirmed: false,
		});
	}

	/** Passes on every command held. */
	flush() {
		for (const command of this.#held.splice(0)) this.out.push(command);
	}

	/**
	 * The `)` before `pos` closes paren depth `depth`. Returns whether it closed a group that is
	 * arithmetic, whose commands are dropped. `))` closes arithmetic: the `)` right behind this one
	 * proves the group below it (`((`) or the `$(` that started the list (`$((`).
	 */
	close(depth: number, pos: number): boolean {
		const top = this.#groups[this.#groups.length - 1];
		if (!top || top.depth !== depth) return false;
		this.#groups.pop();
		if (this.src[pos] === ")") {
			const below = this.#groups[this.#groups.length - 1];
			if (below && below.depth === depth - 1) below.confirmed = true;
			else if (
				!below &&
				this.lone &&
				top.pos === this.listStart &&
				this.src[this.listStart - 1] === "("
			)
				top.confirmed = true;
		}
		if (top.confirmed) this.#held.length = top.start;
		else if (!this.open) this.flush();
		return top.confirmed;
	}
}
