// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are shell text, where ${...} is bash syntax
import {
	ansiQuote,
	backslashQuote,
	backtickBody,
	doubleQuote,
	type Rng,
	singleQuote,
} from "./shell-fuzz-rng.ts";

/**
 * The words of the generator, written from the grammar of bash (`man bash`, "Quoting",
 * "EXPANSION"), not from the lexer under test: quotes of every kind, escapes, every expansion that
 * may run a command, brace expansion, and the here-document bodies.
 */

/** Text that is harmless to bash but hard for a reader of shell text: quotes, parens, comment marks. */
const DECOY = [
	"it's",
	'say "hi"',
	"(",
	")",
	"))",
	"$(",
	"`",
	"# not a comment",
	";;",
	"esac",
	"done",
	"fi",
	"EOF",
	"}",
	"{",
	"<<",
	"$((",
	"&& ||",
	"a b",
	"\\",
	"x=1",
];

/** The decoys an everyday line has: no text that looks like a substitution. */
const TAME_DECOY = DECOY.filter((text) => !/[$`]/.test(text));

const PLAIN = [
	"hi",
	"a",
	"b",
	"x1",
	"-n",
	"--flag",
	"./f",
	"out",
	"a.txt",
	"1",
	"2",
	"foo=bar",
	"a#b",
	"~",
	"*.txt",
	"?",
	"[ab]",
	"-",
	"--",
];

const VARIABLES = ["x", "y", "PATH", "HOME", "arr", "V", "n"];

/** Parameter expansion operators that take a word, so that the word may hold a substitution. */
const OPERATORS = [
	":-",
	"-",
	":=",
	":+",
	"+",
	":?",
	"#",
	"##",
	"%",
	"%%",
	"/",
	"//",
	":",
];

/** Where a word is being written, which decides what it may hold. */
export type WordContext = "bare" | "double";

export abstract class WordGen {
	constructor(
		readonly rng: Rng,
		/** Chooses the planted text and its wrappers; apart from `rng` so the planted text never moves the structure. */
		readonly prng: Rng,
		/** Whether to leave out the constructs that no everyday line has. */
		readonly tame: boolean,
	) {}

	/** A list of commands, for the inside of a substitution or a quoted script. */
	abstract list(depth: number): string;
	/** A list for a substitution: its here-documents are flushed before the closing parenthesis. */
	abstract subList(depth: number): string;

	// -- quoted text ---------------------------------------------------------

	/** The inside of a single-quoted word. */
	sqText(): string {
		const decoys = this.tame ? TAME_DECOY : DECOY;
		const parts: string[] = [];
		for (let i = this.rng.int(3) + 1; i > 0; i--)
			parts.push(
				this.rng.chance(0.5)
					? this.rng.pick(PLAIN)
					: this.rng.pick(decoys).replaceAll("'", ""),
			);
		return parts.join(" ");
	}

	/** A single-quoted word. */
	sq(): string {
		return `'${this.sqText()}'`;
	}

	/** A `$'…'` word; the escapes bash reads inside it, and quotes that look like the end. */
	ansi(): string {
		const pieces = [
			"a",
			"it\\'s",
			"\\\\",
			"\\n",
			"\\t",
			"\\x41",
			"\\101",
			"\\u0041",
			'"',
			"(",
			")",
			"$(",
			"`",
			"#",
			"\\'",
			'\\"',
			"\\e",
			"\\cA",
		];
		const parts: string[] = [];
		for (let i = this.rng.int(3) + 1; i > 0; i--)
			parts.push(this.rng.pick(pieces));
		return `$'${parts.join("")}'`;
	}

	/** A double-quoted word (`$"…"` too), holding text and expansions. */
	dq(depth: number): string {
		const parts: string[] = [];
		for (let i = this.rng.int(3) + 1; i > 0; i--)
			parts.push(this.dqPart(depth));
		return `${this.rng.chance(this.tame ? 0 : 0.1) ? "$" : ""}"${parts.join("")}"`;
	}

	private dqPart(depth: number): string {
		return this.rng.weighted<() => string>([
			[
				5,
				() =>
					this.rng.pick([
						"a",
						" ",
						"it's",
						"'",
						"(",
						")",
						"#",
						";",
						"{",
						"}",
						'\\"',
						"\\\\",
						...(this.tame ? [] : ["\\$", "\\`"]),
						"\n",
						"$ ",
						"x y",
					]),
			],
			[3, () => this.rng.pick(["$x", "${x}", "$1", "$#", "$?", "$@", "$*"])],
			[depth > 0 ? 3 : 0, () => this.subst(depth, "double")],
			[depth > 0 ? 2 : 0, () => this.paramExpansion(depth, "double")],
			[depth > 0 && !this.tame ? 1 : 0, () => this.arith(depth, "double")],
		])();
	}

	// -- expansions ------------------------------------------------------------

	/** A command substitution, `$(…)` or a backtick pair. */
	subst(depth: number, context: WordContext): string {
		if (this.rng.chance(0.75))
			return `$(${this.rng.chance(0.15) ? " " : ""}${this.subList(depth - 1)})`;
		let body = backtickBody(this.subList(depth - 1));
		if (context === "double") body = body.replaceAll('"', '\\"');
		return `\`${body}\``;
	}

	/** A process substitution. */
	procSubst(depth: number): string {
		return `${this.rng.chance(0.5) ? "<" : ">"}(${this.subList(depth - 1)})`;
	}

	/** An arithmetic expansion, `$(( ))` or `$[ ]`; its body may run a command. */
	arith(depth: number, context: WordContext = "bare"): string {
		const body = this.arithBody(depth);
		return this.rng.chance(context === "bare" && !this.tame ? 0.25 : 0)
			? `$[${body}]`
			: `$((${body}))`;
	}

	/** The expression of an arithmetic expansion. */
	arithBody(depth: number): string {
		const term = (): string =>
			this.rng.weighted<() => string>([
				[4, () => String(this.rng.int(10))],
				[2, () => this.rng.pick(["x", "n", "$x", "${n}", "$#", "${#x}"])],
				[depth > 0 && !this.tame ? 2 : 0, () => this.subst(depth, "bare")],
				[
					depth > 0 && !this.tame ? 1 : 0,
					() => `a[${this.subst(depth, "bare")}]`,
				],
			])();
		const ops = [
			"+",
			"-",
			"*",
			"/",
			"%",
			"<<",
			">>",
			"<",
			">",
			"<=",
			"&",
			"|",
			"&&",
			"?1:",
			",",
		];
		let out = term();
		for (let i = this.rng.int(3); i > 0; i--) {
			const op = this.rng.pick(ops);
			out += `${this.rng.chance(0.4) ? " " : ""}${op}${this.rng.chance(0.4) ? " " : ""}${term()}`;
		}
		if (this.rng.chance(0.2)) out = `(${out})`;
		return this.rng.chance(0.3) ? ` ${out} ` : out;
	}

	/** A parameter expansion whose operand may hold a word, a substitution or a subscript. */
	paramExpansion(depth: number, context: WordContext): string {
		const name = this.rng.pick(VARIABLES);
		const operand = (): string =>
			depth > 0 && this.rng.chance(0.6)
				? this.subst(depth, context)
				: this.rng.pick(["d", "", "a b", "*", "'q'", '"q"', "it's", "$x"]);
		return this.rng.weighted<() => string>([
			[3, () => `\${${name}}`],
			[4, () => `\${${name}${this.rng.pick(OPERATORS)}${operand()}}`],
			[2, () => `\${#${name}}`],
			[1, () => `\${!${name}}`],
			[2, () => `\${${name}[${this.rng.pick(["@", "*", "0", "$n"])}]}`],
			[
				depth > 0 && !this.tame ? 2 : 0,
				() => `\${${name}[${this.subst(depth, context)}]}`,
			],
			[
				1,
				() =>
					`\${${name}@${this.rng.pick(this.tame ? ["Q", "U", "a"] : ["Q", "P", "E", "U", "a"])}}`,
			],
			[
				depth > 0 && !this.tame ? 1 : 0,
				() => `\${${name}:${this.subst(depth, context)}:1}`,
			],
			[1, () => `\${${name}${this.rng.pick(["^", "^^", ",", ",,"])}}`],
		])();
	}

	// -- words -----------------------------------------------------------------

	/** One word of any kind that an argument can be. */
	word(depth: number): string {
		return this.rng.weighted<() => string>([
			[6, () => this.rng.pick(PLAIN)],
			[3, () => this.sq()],
			[3, () => this.dq(depth)],
			[this.tame ? 0 : 2, () => this.ansi()],
			[
				2,
				() =>
					this.rng.pick(
						this.tame
							? ["\\ ", "\\'", '\\"', "\\$", "\\(", "\\#", "\\;", "\\&", "\\\\"]
							: [
									"\\ ",
									"\\'",
									'\\"',
									"\\$",
									"\\(",
									"\\#",
									"\\;",
									"\\&",
									"\\\\",
									"\\`",
								],
					),
			],
			[
				3,
				() =>
					this.rng.pick([
						"$x",
						"${x}",
						"$1",
						"$#",
						"$?",
						"$$",
						"$@",
						"$*",
						"$0",
					]),
			],
			[depth > 0 ? 2 : 0, () => this.paramExpansion(depth, "bare")],
			[depth > 0 ? 2 : 0, () => this.subst(depth, "bare")],
			[depth > 0 && !this.tame ? 1 : 0, () => this.procSubst(depth)],
			[depth > 0 ? 1 : 0, () => this.arith(depth)],
			[this.tame ? 0 : 2, () => this.brace(depth)],
			[
				this.tame ? 0 : 1,
				() => this.rng.pick(["a\\\nb", "$(\n)", "{#}", "${#}", "$'\\''"]),
			],
			[1, () => this.concat(depth)],
		])();
	}

	/** A brace expansion, which may carry a substitution. */
	brace(depth: number): string {
		const item = () =>
			depth > 0 && this.rng.chance(0.3)
				? this.subst(depth, "bare")
				: this.rng.pick(["a", "b", "", "1", "$x"]);
		return this.rng.chance(0.2)
			? `{${this.rng.int(3)}..${this.rng.int(3) + 3}}`
			: `${this.rng.pick(["", "p", "x"])}{${item()},${item()}${this.rng.chance(0.3) ? `,${item()}` : ""}}${this.rng.pick(["", "s"])}`;
	}

	/** Pieces of different kinds written next to each other form one word. */
	concat(depth: number): string {
		const pieces: string[] = [];
		for (let i = this.rng.int(2) + 2; i > 0; i--)
			pieces.push(
				this.rng.weighted<() => string>([
					[3, () => this.rng.pick(PLAIN)],
					[2, () => this.sq()],
					[2, () => this.dq(Math.min(depth, 1))],
					[1, () => this.rng.pick(["$x", "${x}", "\\ "])],
				])(),
			);
		return pieces.join("");
	}

	/** A script as one argument of `eval` or `bash -c`: the text, quoted in one of the ways that keep it a script. */
	scriptWord(script: string): string {
		return this.rng.weighted<() => string>([
			[4, () => singleQuote(script)],
			[3, () => doubleQuote(script)],
			[this.tame ? 0 : 2, () => ansiQuote(script)],
			[this.tame ? 0 : 1, () => backslashQuote(script)],
		])();
	}

	// -- here-documents --------------------------------------------------------

	/** A delimiter as written after `<<`, with the word it stands for and whether a body is expanded. */
	delimiter(): { written: string; word: string; expands: boolean } {
		const word = this.rng.pick(["EOF", "END", "XX", "E_O_F", "eof"]);
		return this.rng.weighted<
			() => { written: string; word: string; expands: boolean }
		>([
			[5, () => ({ written: word, word, expands: true })],
			[3, () => ({ written: `'${word}'`, word, expands: false })],
			[2, () => ({ written: `"${word}"`, word, expands: false })],
			[1, () => ({ written: `\\${word}`, word, expands: false })],
			[
				1,
				() => ({
					written: `${word[0]}"${word.slice(1)}"`,
					word,
					expands: false,
				}),
			],
			[
				1,
				() => ({
					written: `${word[0]}\\${word.slice(1)}`,
					word,
					expands: false,
				}),
			],
		])();
	}

	/** The lines of a here-document body, which hold the text that tempts a reader to quote or to comment. */
	heredocBody(depth: number, expands: boolean, delimiter: string): string {
		const lines: string[] = [];
		for (let i = this.rng.int(3); i > 0; i--) {
			let line = this.rng.pick([
				"text",
				"it's",
				'say "hi"',
				"# not a comment",
				"(",
				")",
				...(this.tame ? [] : ["`", "$("]),
				"\\",
				"",
				`${delimiter}X`,
				` ${delimiter}`,
				"'",
				"$((1<<2))",
				"${x:-it's}",
			]);
			if (expands && depth > 0 && this.rng.chance(0.4))
				line += this.rng.chance(0.7)
					? this.subst(depth, "double")
					: this.paramExpansion(depth, "double");
			lines.push(line);
		}
		return lines.map((line) => `${line}\n`).join("");
	}
}
