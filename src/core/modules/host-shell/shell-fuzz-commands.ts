// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are shell text, where ${...} is bash syntax
import { ListGen } from "./shell-fuzz-lists.ts";

/**
 * The compound commands of the generator, written from the grammar of bash (`man bash`, "SHELL
 * GRAMMAR"): `if`, `for`, `while`, `until`, `case`, `select`, groups and subshells, `[[ ]]`,
 * function definitions, `coproc`, aliases, and the commands that run a script held in a word.
 */
export class CommandGen extends ListGen {
	command(depth: number): string {
		if (depth <= 0) return this.decorated(0);
		return this.rng.weighted<() => string>([
			[16, () => this.decorated(depth)],
			[5, () => this.simple(depth)],
			[3, () => this.ifClause(depth)],
			[3, () => this.forClause(depth)],
			[2, () => this.loopClause(depth)],
			[3, () => this.caseClause(depth)],
			[3, () => this.subshell(depth)],
			[3, () => this.group(depth)],
			[2, () => this.arithCommand(depth)],
			[2, () => this.conditional(depth)],
			[2, () => this.definition(depth)],
			[this.tame ? 0 : 2, () => this.selectClause(depth)],
			[this.tame ? 0 : 2, () => this.coprocess(depth)],
			[this.tame ? 0 : 2, () => this.aliasUnit(depth)],
			[this.tame ? 0 : 4, () => this.runner(depth)],
			[this.tame ? 1 : 2, () => this.wrapperChain(depth)],
		])();
	}

	private ifClause(depth: number): string {
		let out = `if ${this.rng.pick(["", "! "])}${this.list(depth - 1)}${this.terminator()}then ${this.body(depth - 1)}`;
		if (this.rng.chance(0.3))
			out += `elif ${this.list(depth - 1)}${this.terminator()}then ${this.body(depth - 1)}`;
		if (this.rng.chance(0.4)) out += `else ${this.body(depth - 1)}`;
		return `${out}fi${this.tail(depth)}`;
	}

	private forClause(depth: number): string {
		const head = this.rng.weighted<() => string>([
			[
				4,
				() =>
					`for i in ${this.word(depth - 1)} ${this.rng.pick(["a", "1 2", "$x"])}${this.headEnd()}`,
			],
			[1, () => `for i${this.headEnd()}`],
			[
				this.tame ? 0 : 1,
				() => `for i in ${this.rng.pick(["", "1"])}${this.headEnd()}`,
			],
			// Both forms end: the condition is false at once, or `i` counts up to it.
			[
				2,
				() =>
					`for ((${this.arithBody(depth - 1)}; ${this.rng.pick(["0", "1<0"])}; ${this.rng.pick(["", "i++"])})); `,
			],
			[1, () => `for ((i=0; i<1; i++)); `],
		])();
		return `${head}do ${this.body(depth - 1)}done${this.tail(depth)}`;
	}

	/** `while` and `until`, which stop after one pass because the body ends with `break`. */
	private loopClause(depth: number): string {
		const keyword = this.rng.pick(["while", "until"]);
		const cond =
			keyword === "while"
				? this.rng.pick(["true", ":", "! false"])
				: this.rng.pick(["false", "! true"]);
		const head = this.rng.chance(0.7)
			? cond
			: `${this.list(depth - 1)}${this.terminator()}${cond}`;
		return `${keyword} ${head}${this.headEnd()}do ${this.list(depth - 1)}${this.terminator()}break${this.headEnd()}done${this.tail(depth)}`;
	}

	private caseClause(depth: number): string {
		const subject = this.rng.weighted<() => string>([
			[5, () => "a"],
			[1, () => '"a"'],
			[depth > 0 ? 2 : 0, () => this.subst(depth, "bare")],
			[1, () => "$x"],
		])();
		const patterns = [
			"a",
			"(a",
			"a|b",
			"b|a",
			"*",
			"?",
			"[a-c]",
			'"a"',
			"'a'",
			"b",
			"c",
			"(b|a",
			"a*",
			"$x",
			"(a|$(true)",
		];
		const lead = this.rng.chance(0.3) ? this.newline() : " ";
		const arms: string[] = [];
		for (let i = this.rng.int(3) + 1; i > 0; i--) {
			const stop = this.rng.pick([";;", ";&", ";;&", " ;;"]);
			arms.push(
				`${this.rng.pick(patterns)}) ${this.list(depth - 1)}${this.rng.pick([" ", ""])}${stop}${this.rng.chance(0.3) ? this.newline() : " "}`,
			);
		}
		if (this.rng.chance(0.2))
			arms.push(
				`${this.rng.pick(patterns)}) ${this.list(depth - 1)}${this.terminator()}`,
			);
		return `case ${subject} in${lead}${arms.join("")}esac${this.tail(depth)}`;
	}

	private subshell(depth: number): string {
		// The opening comes first so that a newline in it takes the here-documents opened before it.
		const open = this.rng.weighted<() => string>([
			[4, () => "("],
			[2, () => "( "],
			[1, () => `(${this.newline()}`],
		])();
		const inner = this.rng.chance(0.15)
			? this.subshell(depth - 1)
			: this.list(depth - 1);
		const close = open.endsWith("\n")
			? `${this.flush(true)}\n)`
			: open === "("
				? ")"
				: " )";
		return `${open}${inner.startsWith("(") && open === "(" ? " " : ""}${inner}${close}${this.tail(depth)}`;
	}

	private group(depth: number): string {
		return `{${this.rng.chance(0.7) ? " " : this.newline()}${this.body(depth - 1)}}${this.tail(depth)}`;
	}

	private arithCommand(depth: number): string {
		return `((${this.arithBody(depth - 1)}))`;
	}

	/** `[[ … ]]`, whose words hold substitutions and patterns. */
	private conditional(depth: number): string {
		const operand = () =>
			depth > 0 && this.rng.chance(0.4)
				? this.subst(depth, "bare")
				: this.rng.pick(["a", '"a"', "$x", "'b'", "*", "a*"]);
		const test = this.rng.weighted<() => string>([
			[
				3,
				() =>
					`${operand()} ${this.rng.pick(["==", "!=", "=", "<", ">"])} ${operand()}`,
			],
			[2, () => `-n ${operand()}`],
			[2, () => `-z ${operand()}`],
			[1, () => `${operand()} -eq ${operand()}`],
			[this.tame ? 0 : 1, () => `${operand()} =~ ^a(b|c)$`],
			[1, () => `( ${operand()} == a )`],
			[1, () => `-f out && ${operand()} != b`],
		])();
		return `[[ ${test} ]]`;
	}

	/** A function definition and a call of it. */
	private definition(depth: number): string {
		// A name of its own, so that no function can end up calling itself.
		const name = `fn${this.functions++}`;
		const body = this.rng.weighted<() => string>([
			[4, () => `{ ${this.body(depth - 1)}}`],
			[2, () => `( ${this.list(depth - 1)} )`],
			[1, () => `{${this.newline()}${this.body(depth - 1)}}`],
			[1, () => `if true; then ${this.body(depth - 1)}fi`],
		])();
		const head = this.rng.pick([
			`${name}()`,
			`${name} ()`,
			`function ${name}`,
			`function ${name}()`,
			`function ${name} ()`,
		]);
		const first = `${head} ${body}`;
		// A second function that the first calls, defined after it.
		if (this.rng.chance(0.2))
			return `${first}${this.headEnd()}fn${this.functions++}() { ${this.body(depth - 1)}}${this.headEnd()}${name}`;
		return `${first}${this.headEnd()}${name}`;
	}

	private selectClause(depth: number): string {
		return `select i in a ${this.word(depth - 1)}; do ${this.list(depth - 1)}${this.terminator()}break${this.headEnd()}done <<< 1`;
	}

	private coprocess(depth: number): string {
		const form = this.rng.pick([
			() => `coproc { ${this.body(depth - 1)}}`,
			() => `coproc NAME { ${this.body(depth - 1)}}`,
			() => `coproc ${this.leaf(depth)}`,
			() => `coproc NAME ( ${this.list(depth - 1)} )`,
		]);
		return `${form()}; wait`;
	}

	/** `alias` defined on one line and used on the next, which is how bash reads an alias. */
	private aliasUnit(depth: number): string {
		const inner = this.subList(depth - 1);
		const use = this.rng.pick([
			() => `alias s=${this.scriptWord(inner)}${this.newline()}s`,
			() =>
				`alias echo=${this.scriptWord(`${inner};`)}${this.newline()}echo hi`,
			() =>
				`alias s=${this.scriptWord(`${inner} `)}${this.newline()}s ${this.word(depth - 1)}`,
		]);
		const enable = this.rng.chance(0.5) ? ";" : this.newline();
		return `shopt -s expand_aliases${enable}${use()}`;
	}

	/** A command that runs a script held in its arguments: `eval`, `bash -c`, `trap`. */
	private runner(depth: number): string {
		const script = this.subList(depth - 1);
		return this.rng.weighted<() => string>([
			[3, () => `eval ${this.scriptWord(script)}`],
			[1, () => `eval ${this.word(depth - 1)}`],
			[
				1,
				() =>
					`eval ${this.rng.pick(["", "echo $a\\b ; "])}${this.scriptWord(script)}`,
			],
			[
				3,
				() =>
					`${this.rng.pick(["bash", "sh"])} ${this.rng.pick(["-c", "-ec", "-o pipefail -c", "--norc -c", "-e -c"])} ${this.scriptWord(script)}`,
			],
			[1, () => `bash -c ${this.dq(depth)}`],
			[
				2,
				() =>
					`trap ${this.scriptWord(script)} ${this.rng.pick(["EXIT", "ERR", "DEBUG", "0", "INT"])}`,
			],
			[1, () => `trap -- ${this.scriptWord(script)} EXIT`],
			[
				1,
				() =>
					`${this.rng.pick(["time", "command", "env", "exec", "builtin"])} eval ${this.scriptWord(script)}`,
			],
			[
				1,
				() =>
					`xargs ${this.rng.pick(["", "-n1 "])}bash -c ${this.scriptWord(script)}`,
			],
			[1, () => `find . -exec bash -c ${this.scriptWord(script)} \\;`],
		])();
	}

	/** A wrapper in front of a command, which is a slot. */
	private wrapperChain(depth: number): string {
		const prefix = this.rng.pick([
			"command",
			"env",
			"exec",
			"time",
			"nice",
			"nohup",
			"timeout 5",
			"xargs",
			"builtin",
			"stdbuf -oL",
			"env FOO=1",
			"nice -n 5",
		]);
		return `${prefix} ${this.leaf(depth)}`;
	}
}
