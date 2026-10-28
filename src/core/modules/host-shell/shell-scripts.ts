import { basename } from "node:path";
import type { LineState } from "./shell-paths.ts";

/** Shells that run the command given with `-c`, or a script from a file or standard input. */
export const SHELLS: ReadonlySet<string> = new Set([
	"bash",
	"sh",
	"zsh",
	"dash",
	"ksh",
	"ash",
]);

/** Shell options that take the next word as their argument. */
const SHELL_OPTIONS_WITH_ARGUMENT = new Set([
	"-o",
	"+o",
	"-O",
	"+O",
	"--rcfile",
	"--init-file",
]);

/** The command a shell runs from its arguments (`-c`, also in a cluster such as `-ec`), if it is given one. */
export function shellScript(args: readonly string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (SHELL_OPTIONS_WITH_ARGUMENT.has(arg)) i++;
		else if (/^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) return args[i + 1];
		else if (!/^[-+]/.test(arg) || arg === "--") return undefined;
	}
	return undefined;
}

/** Files that stand for the script text another command or a here-document gives on standard input, and a process substitution. */
const STDIN_FILE = /^(?:\/(?:dev\/(?:stdin|fd\/|tty)|proc\/)|[<>]\()/;

/** A written path as the line names it, without a leading `./`. */
const normal = (path: string): string => path.replace(/^(?:\.\/)+/, "");

/**
 * How a shell gets its script when it has no `-c`: from standard input (`-s`, `-`, or no operand at
 * all), or from the file it is given, which is its first word that is not an option.
 */
function scriptSource(args: readonly string[]): {
	stdin: boolean;
	file?: string;
} {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (SHELL_OPTIONS_WITH_ARGUMENT.has(arg)) i++;
		else if (arg === "--")
			return args[i + 1] === undefined
				? { stdin: true }
				: { stdin: false, file: args[i + 1] };
		else if (arg === "-") return { stdin: true };
		else if (/^-[A-Za-z]*s[A-Za-z]*$/.test(arg)) return { stdin: true };
		else if (!/^[-+]/.test(arg)) return { stdin: false, file: arg };
	}
	return { stdin: true };
}

/**
 * Whether a command runs a script that the line does not show in a word of its own: a shell with
 * no `-c` script reads its commands from standard input (a pipe, a here-document, a here-string,
 * a process substitution) or from a file the line wrote; `source` and `.` do the same; a program
 * the line wrote runs. A shell that `xargs` starts takes its script or file from the input.
 * Running a script file that the line did not write is no different from running any program.
 */
export function readsUnseenScript(
	word: string,
	name: string,
	args: readonly string[],
	prefix: readonly string[],
	state: LineState,
): boolean {
	const fromInput = prefix.includes("xargs");
	const written = (path: string | undefined): boolean =>
		path !== undefined && state.written.has(normal(path));
	if (SHELLS.has(name)) {
		if (shellScript(args) !== undefined) return false;
		const { stdin, file } = scriptSource(args);
		return (
			fromInput ||
			stdin ||
			(file !== undefined && (STDIN_FILE.test(file) || written(file)))
		);
	}
	if (name === "source" || name === ".") {
		const [file] = args;
		return (
			fromInput || file === undefined || STDIN_FILE.test(file) || written(file)
		);
	}
	return /^\.{0,2}\//.test(word) && written(word);
}

/** Notes the files a command writes: the targets of `>` and `>>`, and the operands of `tee`. */
export function recordWrites(
	words: readonly string[],
	teeOperands: readonly string[],
	state: LineState,
): void {
	for (let i = 0; i < words.length - 1; i++)
		if (words[i] === ">" || words[i] === ">>")
			state.written.add(normal(words[i + 1] as string));
	for (const operand of teeOperands)
		if (!operand.startsWith("-")) state.written.add(normal(operand));
}

/** The operands of `tee` in a command, or none when it is another program. */
export function teeOperands(name: string, args: readonly string[]): string[] {
	return basename(name) === "tee" ? [...args] : [];
}
