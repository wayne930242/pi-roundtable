// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are shell text, where ${...} is bash syntax
import { Planter } from "./shell-fuzz-plant.ts";
import type { Rng } from "./shell-fuzz-rng.ts";
import { WordGen } from "./shell-fuzz-words.ts";

/**
 * The lists of the generator, written from the grammar of bash (`man bash`, "SHELL GRAMMAR"):
 * simple commands with assignments and redirections, pipelines, and lists with every separator.
 * Every command position is a slot; the slots listed in `plantAt` hold the planted `sudo marker`,
 * the others a harmless command. The compound commands are in `shell-fuzz-commands.ts`.
 */

/** What a harmless command is made of: builtins and names that are not on the stub PATH. */
const BUILTIN_FILLERS = [
	"echo",
	"echo",
	"printf '%s\\n'",
	"true",
	"false",
	":",
	"test -n",
	"[ a = a ]",
	"cat out",
	"read -t 0 x",
	"wait",
	"export V=1",
	"set --",
	"declare -i n=1",
	"local v",
	"shift",
	"type -t echo",
	"ls",
	"git status",
];

/** Everyday commands, none of which a sensible rule would hold. */
const EVERYDAY = [
	"git status --short",
	"git diff --stat HEAD~1",
	"git log --oneline -n 5",
	"git add src/a.ts src/b.ts",
	"git commit -m wip",
	"ls -la",
	"cat package.json",
	"grep -rn foo src",
	"grep -q foo out.txt",
	"echo done",
	"npm test",
	"bun test",
	"bun run lint",
	"tsc --noEmit",
	"mkdir -p build",
	"cp a.txt b.txt",
	"mv a.txt b.txt",
	"touch out.txt",
	"curl -s http://localhost:3000/health",
	"jq .name package.json",
	"sed -n 1,5p out.txt",
	"awk '{print $1}' out.txt",
	"sort out.txt",
	"wc -l out.txt",
	"head -n 5 out.txt",
	"tail -n 5 out.txt",
	"find . -name '*.ts' -type f",
	"date +%s",
	"sleep 1",
	"export FOO=bar",
	"node script.js",
	"python3 -m pytest",
	"docker ps",
	"gh pr view",
	"test -f out.txt",
	"[ -d src ]",
	"pwd",
	"which node",
	"true",
	"false",
	"echo $((1 + 2))",
	"printf '%s\\n' hi",
];

const FILE_TARGETS = ["/dev/null", "/dev/null", "out", "out2"];
/** Other device nodes a line may write to; an everyday line leaves them out, as the rule holds them. */
const DEVICE_TARGETS = ["/dev/stdout", "/dev/stderr"];

export abstract class ListGen extends WordGen {
	/** The command positions seen so far. */
	slots = 0;
	/** The functions defined so far, which get a name each. */
	functions = 0;
	/** Here-documents whose bodies come after the next newline: the text from the delimiter on. */
	pending: string[] = [];
	readonly planter: Planter;

	constructor(
		rng: Rng,
		prng: Rng,
		tame: boolean,
		/** The slots that hold the planted command. */
		readonly plantAt: ReadonlySet<number>,
		/** The nesting a line may have. */
		readonly maxDepth: number,
	) {
		super(rng, prng, tame);
		this.planter = new Planter(prng);
	}

	/** A whole command line: a list, with the here-documents it opened written out at its end. */
	top(): string {
		const body = this.list(this.maxDepth);
		return `${body}${this.flush(true)}`;
	}

	/** The bodies of the here-documents opened since the last newline; `lead` writes the newline they follow. */
	flush(lead: boolean): string {
		if (this.pending.length === 0) return "";
		const bodies = this.pending.join("");
		this.pending = [];
		return `${lead ? "\n" : ""}${bodies}`;
	}

	subList(depth: number): string {
		const outer = this.pending;
		this.pending = [];
		const body = this.list(depth);
		const out = `${body}${this.flush(true)}`;
		this.pending = outer;
		return out;
	}

	// -- slots ------------------------------------------------------------------

	/** A command position: the planted command if the slot is chosen, else a harmless command. */
	leaf(depth: number): string {
		const filler = this.filler(depth);
		const at = this.slots++;
		if (!this.plantAt.has(at)) return filler;
		return !this.tame && this.prng.chance(0.08)
			? this.planter.hidden()
			: this.planter.plant();
	}

	/** A harmless command with a few words. */
	filler(depth: number): string {
		const name = this.tame
			? this.rng.pick(EVERYDAY)
			: this.rng.pick(BUILTIN_FILLERS);
		let out = name;
		for (
			let i = this.rng.weighted([
				[5, 0],
				[4, 1],
				[1, 2],
			]);
			i > 0;
			i--
		)
			out += ` ${this.word(depth - 1)}`;
		return out;
	}

	// -- lists -------------------------------------------------------------------

	list(depth: number): string {
		const count =
			depth <= 0
				? 1
				: this.rng.weighted([
						[10, 1],
						[3, 2],
						[1, 3],
					]);
		let out = this.rng.chance(0.04) ? this.commentLine() : "";
		for (let i = 0; i < count; i++) {
			out += this.andOr(depth);
			if (i === count - 1) break;
			// A comment runs to the end of the line, so the statement after it starts on a new one.
			const commented = this.rng.chance(0.1);
			if (commented) out += ` #${this.commentText()}`;
			out += this.separator(commented);
		}
		return out;
	}

	protected commentText(): string {
		return ` ${this.rng.pick(["note", "it's", "'", '"', "(", ")", "$(", "`", "))", "esac", "sudo marker", "\\", "x # y"])}`;
	}

	protected commentLine(): string {
		return `# ${this.commentText().trim()}\n`;
	}

	/** What ends a statement: `;`, `&`, a newline in any of its spellings. */
	protected separator(afterComment: boolean): string {
		if (afterComment) return this.newline();
		return this.rng.weighted<() => string>([
			[4, () => "; "],
			[2, () => ";"],
			[3, () => this.newline()],
			[1, () => " ; "],
			[1, () => `;${this.newline()}`],
			[1, () => " & "],
			[this.tame ? 0 : 1, () => this.newline("\r\n")],
			[1, () => this.newline("\n\n")],
			[this.tame ? 0 : 1, () => " \\\n; "],
		])();
	}

	/** A newline, and the here-documents that follow it. */
	protected newline(text = "\n"): string {
		return `${text}${this.flush(false)}`;
	}

	/** What ends a body before `then`, `fi`, `do`, `done`, `}` and `;;`. */
	protected terminator(): string {
		return this.rng.weighted<() => string>([
			[4, () => "; "],
			[2, () => ";"],
			[3, () => this.newline()],
			[1, () => ` &${this.newline()}`],
			[1, () => ` ;${this.newline()}`],
		])();
	}

	/** What ends the head of a `for`, `while` or `case`, where a `&` is not allowed. */
	protected headEnd(): string {
		return this.rng.weighted<() => string>([
			[4, () => "; "],
			[2, () => ";"],
			[3, () => this.newline()],
		])();
	}

	/** A body: a list with its terminator. */
	body(depth: number): string {
		return `${this.list(depth)}${this.terminator()}`;
	}

	andOr(depth: number): string {
		let out = this.pipeline(depth);
		for (
			let i = this.rng.weighted([
				[8, 0],
				[3, 1],
				[1, 2],
			]);
			i > 0;
			i--
		)
			out += `${this.rng.pick([" && ", " || ", "&&", "||"])}${this.rng.chance(0.1) ? this.newline() : ""}${this.pipeline(depth)}`;
		return out;
	}

	pipeline(depth: number): string {
		let out = this.rng.chance(0.08) ? "! " : "";
		if (!this.tame && this.rng.chance(0.06))
			out += this.rng.pick(["time ", "time -p ", "time -- "]);
		out += this.command(depth);
		for (
			let i = this.rng.weighted([
				[7, 0],
				[3, 1],
				[1, 2],
			]);
			i > 0;
			i--
		)
			out += `${this.rng.pick([" | ", "|", " |& "])}${this.rng.chance(0.08) ? this.newline() : ""}${this.command(depth)}`;
		return out;
	}

	// -- commands ----------------------------------------------------------------

	abstract command(depth: number): string;

	/** A slot with the assignments and redirections bash allows around a command. */
	decorated(depth: number): string {
		let out = "";
		for (
			let i = this.rng.weighted([
				[12, 0],
				[3, 1],
				[1, 2],
			]);
			i > 0;
			i--
		)
			out += `${this.assignment(depth)} `;
		for (
			let i = this.rng.weighted([
				[12, 0],
				[3, 1],
				[1, 2],
			]);
			i > 0;
			i--
		)
			out += `${this.redirect(depth)} `;
		out += this.leaf(depth);
		for (
			let i = this.rng.weighted([
				[10, 0],
				[3, 1],
				[1, 2],
			]);
			i > 0;
			i--
		)
			out += ` ${this.redirect(depth)}`;
		return out;
	}

	/** A simple command that is not a slot, built from words that may hold substitutions. */
	simple(depth: number): string {
		const names = this.tame
			? ["echo", "printf '%s\\n'", "cat", "git commit -m", "grep", "ls"]
			: [
					"echo",
					"printf '%s\\n'",
					"cat",
					"export",
					"declare",
					"local",
					"let",
					"read",
					"set --",
					"eval",
					"test",
					"[",
					"shift",
					"return",
				];
		let out = this.rng.pick(names);
		for (
			let i = this.rng.weighted([
				[4, 0],
				[4, 1],
				[2, 2],
				[1, 3],
			]);
			i > 0;
			i--
		)
			out += `${this.rng.chance(0.06) ? " \\\n " : " "}${this.rng.chance(0.2) ? this.redirect(depth) : this.word(depth - 1)}`;
		if (out.startsWith("[") && !out.startsWith("[[")) out += " ]";
		return out;
	}

	/** A variable assignment before a command, with a value that may run a command. */
	assignment(depth: number): string {
		const name = this.rng.pick(["A", "FOO", "x", "arr"]);
		return this.rng.weighted<() => string>([
			[4, () => `${name}=${this.rng.pick(["1", "", "a", "'q'"])}`],
			[3, () => `${name}=${this.dq(depth - 1)}`],
			[depth > 0 ? 3 : 0, () => `${name}=${this.subst(depth, "bare")}`],
			[1, () => `${name}+=b`],
			[this.tame ? 0 : 1, () => `${name}=(a b ${this.word(depth - 1)})`],
			[this.tame ? 0 : 1, () => `${name}[1]=x`],
			[
				this.tame || depth <= 0 ? 0 : 1,
				() => `${name}[${this.subst(depth, "bare")}]=1`,
			],
		])();
	}

	/** A redirection, here-documents and here-strings included. */
	redirect(depth: number): string {
		return this.rng.weighted<() => string>([
			[
				4,
				() =>
					`${this.rng.pick(["", "1", "2"])}>${this.rng.pick(["", " "])}${this.rng.pick(this.tame ? FILE_TARGETS : [...FILE_TARGETS, ...DEVICE_TARGETS])}`,
			],
			[2, () => `>>${this.rng.pick(["out", "/dev/null"])}`],
			[
				3,
				() =>
					this.rng.pick([
						"2>&1",
						">&2",
						"1>&2",
						"3>&1",
						"3>&-",
						"<&0",
						"0<&-",
						"2>&-",
					]),
			],
			[2, () => `<${this.rng.pick(["", " "])}/dev/null`],
			[this.tame ? 0 : 1, () => `&>${this.rng.pick(["/dev/null", "out"])}`],
			[this.tame ? 0 : 1, () => `>|${this.rng.pick(["", " "])}/dev/null`],
			[this.tame ? 0 : 1, () => "<>/dev/null"],
			[this.tame ? 0 : 1, () => ">&/dev/null"],
			[
				depth > 0 && !this.tame ? 2 : 0,
				() =>
					`>${this.rng.pick(["", " "])}${this.rng.pick(["", '"', ""])}$(${this.subList(depth - 1)})`.replace(
						/^(>\s?)"/,
						"$1",
					),
			],
			[3, () => `<<<${this.rng.pick(["", " "])}${this.word(depth - 1)}`],
			[3, () => this.heredoc(depth)],
		])();
	}

	/** `<<DELIM` or `<<-DELIM`; the body is written at the next newline. */
	heredoc(depth: number): string {
		const { written, word, expands } = this.delimiter();
		const strip = this.rng.chance(0.25);
		const body = this.heredocBody(depth - 1, expands, word);
		const indent = strip ? "\t" : "";
		const text = body
			.split("\n")
			.slice(0, -1)
			.map((line) => `${indent}${line}\n`)
			.join("");
		this.pending.push(`${text}${indent}${word}\n`);
		return `<<${strip ? "-" : ""}${this.rng.pick(["", " "])}${written}`;
	}

	/** Redirections after a compound command, and nothing most of the time. */
	protected tail(depth: number): string {
		return this.rng.chance(0.15) ? ` ${this.redirect(depth)}` : "";
	}
}
