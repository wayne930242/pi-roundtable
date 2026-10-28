/**
 * Splits a bash command line into the simple commands bash would run, for the shell hold rule.
 *
 * The rule's one promise is: if bash runs a held command, the line is held. So the lexer reads
 * the way bash does, and where it cannot (a line too long or too deeply nested, or a construct it
 * cannot place), it gives up with `unreadable` and the rule holds the whole line. It never guesses
 * that text is inert. What it must therefore know is where each kind of text ends: single, double
 * and `$'…'` quotes, `$(…)`, backticks, `${…}`, `$[…]`, comments, here-document bodies and `case`
 * patterns.
 */

import {
	ansiQuoted,
	heredocBody,
	readDelimiter,
	Unreadable,
} from "./shell-quoting.ts";

/** A line longer than this is not read. */
const MAX_LENGTH = 200_000;
/** Nested substitutions deeper than this are not read. */
const MAX_DEPTH = 48;

/** Words that can start a command line before the command itself: `then sudo ls` runs `sudo`. */
export const COMMAND_PREFIX_WORDS: ReadonlySet<string> = new Set([
	"if",
	"then",
	"elif",
	"else",
	"do",
	"while",
	"until",
	"!",
	"coproc",
	"function",
]);

/** Words that can come before `case` or `esac` in a command that is still at its start. */
const KEYWORDS_BEFORE_CASE: ReadonlySet<string> = new Set([
	...COMMAND_PREFIX_WORDS,
	"time",
]);

/** The commands of a line, or `unreadable` when the lexer could not tell what bash would run. */
export interface Lexed {
	commands: string[][];
	unreadable: boolean;
}

/** A here-document waiting for the end of its line. */
interface Pending {
	owner: number;
	delimiter: string;
	quoted: boolean;
	stripTabs: boolean;
}

const isSpace = (ch: string) => /\s/.test(ch);

/** Splits a command line into simple commands of words; quotes are removed, operators separate. */
export function lexShell(command: string): Lexed {
	if (command.length > MAX_LENGTH) return { commands: [], unreadable: true };
	try {
		const lexer = new Lexer(command, { depth: 0 }, false);
		return { commands: lexer.list("eof"), unreadable: false };
	} catch (error) {
		// A stack that ran out is a line too deep to read, whatever the cap says.
		if (error instanceof Unreadable || error instanceof RangeError)
			return { commands: [], unreadable: true };
		throw error;
	}
}

/** Splits a command line into simple commands of words; the commands of a line that cannot be read are none. */
export function simpleCommands(command: string): string[][] {
	return lexShell(command).commands;
}

class Lexer {
	pos = 0;
	/** Here-documents whose bodies follow the line being read. */
	readonly pending: Pending[] = [];
	#calls = 0;

	constructor(
		readonly src: string,
		readonly shared: { depth: number },
		/** Whether `<<` is a shift: the text is arithmetic, where there are no here-documents. */
		readonly arithmetic: boolean,
	) {}

	#enter() {
		if (++this.shared.depth > MAX_DEPTH) throw new Unreadable();
	}

	#leave() {
		this.shared.depth--;
	}

	/**
	 * The commands from here to the end of the text, or, for `paren`, to the `)` that closes the
	 * substitution that starts here.
	 */
	list(end: "eof" | "paren"): string[][] {
		const id = ++this.#calls;
		const s = this.src;
		const out: string[][] = [];
		let words: string[] = [];
		let word = "";
		let inWord = false;
		// Whether the word was written without a quote, escape or expansion, so it may be a keyword.
		let plain = true;
		let parenDepth = 0;
		let caseOpen = 0;
		/** Whether the next `)` in a `case` ends a pattern: after `in` and after `;;`. */
		let expectPattern = false;
		/** How many words of the current command come before a `case` pattern (`case x in`). */
		let patternBase = 0;
		/** The paren depths of the open `((` groups, which are arithmetic. */
		const arith: number[] = [];
		let sawShift = false;
		const endWord = () => {
			if (!inWord) return;
			if (plain && words.every((w) => KEYWORDS_BEFORE_CASE.has(w))) {
				if (word === "case") {
					caseOpen++;
					expectPattern = false;
				} else if (word === "esac" && caseOpen > 0) {
					caseOpen--;
					expectPattern = false;
				}
			} else if (plain && word === "in" && caseOpen > 0) {
				// `case WORD in`: the first pattern follows.
				const at = words.lastIndexOf("case");
				if (at !== -1 && words.length - at === 2) {
					expectPattern = true;
					patternBase = words.length + 1;
				}
			}
			words.push(word);
			word = "";
			inWord = false;
			plain = true;
		};
		const endCommand = () => {
			endWord();
			if (words.length > 0) out.push(words);
			words = [];
			patternBase = 0;
		};
		const quoted = (text: string) => {
			word += text;
			inWord = true;
			plain = false;
		};
		while (this.pos < s.length) {
			const ch = s[this.pos] as string;
			const next = s[this.pos + 1];
			if (ch === "\\") {
				if (next === undefined) this.pos++;
				else if (next === "\n") this.pos += 2;
				else {
					quoted(next);
					this.pos += 2;
				}
			} else if (ch === "'") {
				const close = s.indexOf("'", this.pos + 1);
				const stop = close === -1 ? s.length : close;
				quoted(s.slice(this.pos + 1, stop));
				this.pos = stop + 1;
			} else if (ch === '"') {
				this.pos++;
				quoted(this.#doubleQuoted(out));
			} else if (ch === "$") {
				if (next === "'") quoted(this.#ansiQuoted());
				else if (next === '"') {
					this.pos += 2;
					quoted(this.#doubleQuoted(out));
				} else if (next === "(") {
					// The text is dropped and the word keeps the mark, so a value built from it counts as unknown.
					this.#paren(out);
					quoted("$(");
				} else if (next === "{") quoted(this.#param(out, false));
				else if (next === "[") quoted(this.#bracket(out));
				else {
					word += "$";
					inWord = true;
					this.pos++;
				}
			} else if (ch === "`") {
				this.#backtick(out);
				quoted("`");
			} else if (ch === "\n") {
				endCommand();
				this.pos++;
				if ((this.arithmetic || arith.length > 0) && sawShift)
					throw new Unreadable();
				this.#drain(id, out);
			} else if (isSpace(ch)) {
				endWord();
				this.pos++;
			} else if (
				ch === "#" &&
				!inWord &&
				(this.pos === 0 || " \t\n;&|()<>".includes(s[this.pos - 1] as string))
			) {
				// A comment: a `)` or a quote in it means nothing.
				const stop = s.indexOf("\n", this.pos);
				const comment = s.slice(this.pos, stop === -1 ? s.length : stop);
				// Bash 3.2 and 5 differ on a quote in a comment inside a substitution; neither reading is trusted.
				if (this.shared.depth > 0 && /['"`]/.test(comment))
					throw new Unreadable();
				this.pos += comment.length;
			} else if (ch === "(" && caseOpen > 0 && expectPattern && !inWord) {
				// The optional `(` before a `case` pattern; its `)` is the one that ends the pattern.
				this.pos++;
			} else if (ch === "(") {
				endCommand();
				parenDepth++;
				if (next === "(" || s[this.pos - 1] === "(") arith.push(parenDepth);
				this.pos++;
			} else if (ch === ")") {
				endWord();
				this.pos++;
				if (parenDepth > 0) {
					if (arith[arith.length - 1] === parenDepth) arith.pop();
					if (arith.length === 0 && !this.arithmetic) sawShift = false;
					parenDepth--;
					endCommand();
				} else if (caseOpen > 0) {
					// The `)` that ends a `case` pattern; the pattern runs nothing. Any other `)` there is
					// one that bash versions place differently, so the line is not read.
					// A pattern is one word; anything more is not one bash would accept.
					if (!expectPattern || words.length - patternBase > 1)
						throw new Unreadable();
					expectPattern = false;
					words = [];
				} else {
					endCommand();
					if (end === "paren") {
						if (this.pending.some((p) => p.owner === id))
							throw new Unreadable();
						return out;
					}
				}
			} else if (
				";&|".includes(ch) ||
				(ch === "{" && (next === undefined || isSpace(next))) ||
				(ch === "}" && this.#closesGroup())
			) {
				endCommand();
				if (ch === ";" && caseOpen > 0 && (next === ";" || next === "&"))
					expectPattern = true;
				this.pos++;
			} else if (ch === ">" || ch === "<") {
				endWord();
				if (ch === "<" && next === "<") {
					if (this.#shiftOrHeredoc(id, words, arith.length > 0))
						sawShift = true;
					continue;
				}
				// Redirections become their own words, so their targets can be checked.
				let op = ch;
				this.pos++;
				if (s[this.pos] === ">") {
					op += ">";
					this.pos++;
				}
				if (op === "<>") op = ">"; // opens the file for writing too
				if (op === ">" && s[this.pos] === "|") this.pos++; // `>|` forces the overwrite
				if (op !== "<" && s[this.pos] === "&") {
					this.pos++;
					// `>&2` and `>&-` duplicate or close a descriptor; `>& file` names a file.
					if (/\s*[0-9-]/y.test(s.slice(this.pos, this.pos + 64))) op = "dup";
				}
				words.push(op);
			} else {
				word += ch;
				inWord = true;
				this.pos++;
			}
		}
		endCommand();
		return out;
	}

	/**
	 * Whether the `}` that starts here closes a group: a word of its own after a separator. Any
	 * other `{` or `}` is part of a word, which may be a brace expansion such as `{sudo,ls}`.
	 */
	#closesGroup(): boolean {
		const before = this.src[this.pos - 1];
		const after = this.src[this.pos + 1];
		return (
			(before === undefined || isSpace(before) || ";&|()".includes(before)) &&
			(after === undefined || isSpace(after) || ";&|()<>".includes(after))
		);
	}

	/**
	 * `<<<`, a shift in arithmetic, or a here-document, at the `<<` that starts here. Returns
	 * whether it was a shift, which a newline after it in the same arithmetic makes unreadable.
	 */
	#shiftOrHeredoc(id: number, words: string[], inArithmetic: boolean): boolean {
		const s = this.src;
		if (s[this.pos + 2] === "<") {
			words.push("<");
			this.pos += 3;
			return false;
		}
		if (this.arithmetic || inArithmetic) {
			words.push("<");
			this.pos += 2;
			return true;
		}
		this.pos += 2;
		let stripTabs = false;
		if (s[this.pos] === "-") {
			stripTabs = true;
			this.pos++;
		}
		while (s[this.pos] === " " || s[this.pos] === "\t") this.pos++;
		const { text, quoted, end } = readDelimiter(s, this.pos);
		this.pos = end;
		this.pending.push({ owner: id, delimiter: text, quoted, stripTabs });
		// The delimiter stays a word so the redirection's target is skipped like any other.
		words.push("<", text);
		return false;
	}

	/** Reads the bodies of the here-documents of the line that just ended, and the expansions in them. */
	#drain(id: number, out: string[][]) {
		const s = this.src;
		for (let p = this.pending.shift(); p; p = this.pending.shift()) {
			// A line ended inside another substitution than the one that opened the here-document.
			if (p.owner !== id) throw new Unreadable();
			const start = this.pos;
			const { bodyEnd, next } = heredocBody(s, start, p);
			if (!p.quoted) {
				const body = new Lexer(
					s.slice(start, bodyEnd),
					this.shared,
					this.arithmetic,
				);
				for (const command of body.expansions()) out.push(command);
			}
			this.pos = next;
		}
	}

	/** The commands run by the expansions in text that is not split into words (a here-document body). */
	expansions(): string[][] {
		const out: string[][] = [];
		const s = this.src;
		while (this.pos < s.length) {
			const ch = s[this.pos] as string;
			const next = s[this.pos + 1];
			if (ch === "\\") this.pos += 2;
			else if (ch === "`") this.#backtick(out);
			else if (ch === "$" && next === "(") this.#paren(out);
			else if (ch === "$" && next === "{") this.#param(out, true);
			else if (ch === "$" && next === "[") this.#bracket(out);
			else this.pos++;
		}
		return out;
	}

	/** The text of a double-quoted string that starts here, after its opening quote; its substitutions run. */
	#doubleQuoted(out: string[][]): string {
		const s = this.src;
		let text = "";
		while (this.pos < s.length) {
			const ch = s[this.pos] as string;
			const next = s[this.pos + 1];
			if (ch === '"') {
				this.pos++;
				return text;
			}
			if (ch === "\\") {
				// A backslash before a newline joins the lines.
				if (next !== undefined && next !== "\n") text += next;
				this.pos += 2;
			} else if (ch === "`") text += this.#backtick(out);
			else if (ch === "$" && next === "(") text += this.#paren(out);
			else if (ch === "$" && next === "{") text += this.#param(out, true);
			else if (ch === "$" && next === "[") text += this.#bracket(out);
			else {
				text += ch;
				this.pos++;
			}
		}
		return text;
	}

	/** The text of a `$'…'` string that starts here, with its escapes decoded. */
	#ansiQuoted(): string {
		const found = ansiQuoted(this.src, this.pos);
		this.pos = found.end;
		return found.text;
	}

	/** A `$(…)` that starts here: its commands go to `out`; returns its text. An unterminated one runs to the end. */
	#paren(out: string[][]): string {
		const start = this.pos;
		this.#enter();
		this.pos += 2;
		for (const command of this.list("paren")) out.push(command);
		this.#leave();
		return this.src.slice(start, this.pos);
	}

	/** A backtick substitution that starts here: its commands go to `out`; returns its text. */
	#backtick(out: string[][]): string {
		const s = this.src;
		const start = this.pos;
		let inner = "";
		let i = start + 1;
		for (; i < s.length && s[i] !== "`"; i++) {
			const next = s[i + 1];
			if (s[i] === "\\" && next && "`\\$".includes(next)) i++;
			inner += s[i];
		}
		this.pos = Math.min(i + 1, s.length);
		this.#enter();
		const body = new Lexer(inner, this.shared, this.arithmetic);
		for (const command of body.list("eof")) out.push(command);
		this.#leave();
		return s.slice(start, this.pos);
	}

	/**
	 * A `${…}` that starts here: the substitutions in it run, and a `}` in a quote or behind a
	 * backslash does not end it. Returns its text.
	 */
	#param(out: string[][], inDouble: boolean): string {
		return this.#braced(out, "}", undefined, inDouble);
	}

	/** A `$[…]` that starts here: arithmetic, where there are no here-documents. Returns its text. */
	#bracket(out: string[][]): string {
		return this.#braced(out, "]", "[", false);
	}

	#braced(
		out: string[][],
		close: string,
		open: string | undefined,
		inDouble: boolean,
	): string {
		const s = this.src;
		const start = this.pos;
		this.#enter();
		this.pos += 2;
		let depth = 1;
		while (this.pos < s.length) {
			const ch = s[this.pos] as string;
			const next = s[this.pos + 1];
			if (ch === close && --depth === 0) {
				this.pos++;
				break;
			}
			if (ch === open) {
				depth++;
				this.pos++;
			} else if (ch === "\\") this.pos += 2;
			else if (ch === "'" && !inDouble) {
				const stop = s.indexOf("'", this.pos + 1);
				this.pos = stop === -1 ? s.length : stop + 1;
			} else if (ch === '"') {
				this.pos++;
				this.#doubleQuoted(out);
			} else if (ch === "`") this.#backtick(out);
			else if (ch === "$" && next === "(") this.#paren(out);
			else if (ch === "$" && next === "{") this.#param(out, inDouble);
			else if (ch === "$" && next === "[") this.#bracket(out);
			else this.pos++;
		}
		this.#leave();
		this.pos = Math.min(this.pos, s.length);
		return s.slice(start, this.pos);
	}
}
