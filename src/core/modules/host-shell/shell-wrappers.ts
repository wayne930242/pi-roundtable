import { basename } from "node:path";
import { COMMAND_PREFIX_WORDS } from "./shell-lexer.ts";

/** A variable assignment word, `NAME=value` or `NAME+=value`, as it stands before a command. */
export const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/**
 * Words that run the next word as the command, with the options of each that take the word after
 * them as their argument (`env -u NAME`, `timeout -s KILL`): that word is not the command.
 */
export const WRAPPERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	[
		"env",
		new Set(["-u", "--unset", "-C", "--chdir", "-P", "-S", "--split-string"]),
	],
	["nohup", new Set()],
	["time", new Set(["-f", "--format", "-o", "--output"])],
	["nice", new Set(["-n", "--adjustment"])],
	["ionice", new Set(["-c", "--class", "-n", "--classdata", "-p", "-P", "-u"])],
	["timeout", new Set(["-s", "--signal", "-k", "--kill-after"])],
	["stdbuf", new Set(["-i", "--input", "-o", "--output", "-e", "--error"])],
	["exec", new Set(["-a"])],
	["command", new Set()],
	["builtin", new Set()],
	[
		"xargs",
		new Set(["-n", "-I", "-J", "-P", "-L", "-s", "-d", "-E", "-a", "-R", "-S"]),
	],
	["setsid", new Set()],
	["unbuffer", new Set()],
	["caffeinate", new Set(["-t", "-w"])],
]);

/** Whether a word is the duration `timeout` takes, or the number a wrapper option leaves behind. */
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/;

/** The string `xargs` replaces with each input line (`-I str`, `-Istr`, `-J str`, `-i`, `--replace`), given one of its options and the word after it. */
function xargsReplace(
	option: string,
	next: string | undefined,
): string | undefined {
	if (option === "-I" || option === "-J") return next;
	if (option.startsWith("-I") || option.startsWith("-J"))
		return option.slice(2);
	if (option === "-i" || option === "--replace") return "{}";
	if (option.startsWith("-i") || option.startsWith("--replace="))
		return option.slice(
			option.indexOf("=") === -1 ? 2 : option.indexOf("=") + 1,
		);
	return undefined;
}

/** The string that stands for the input in an `xargs` of `prefix` (the words `program` dropped), if it has one. */
export function replaceString(prefix: readonly string[]): string | undefined {
	return prefix.find((word) => word.startsWith("xargs -I "))?.slice(9);
}

/**
 * Drops leading variable assignments, wrappers, and their options, leaving the real program;
 * `prefix` collects what was dropped. An `env -S` splits its argument into a command line, so it is
 * recorded as `env -S` for the caller to hold, and the string an `xargs` replaces as `xargs -I str`.
 */
export function program(words: string[], prefix: string[] = []): string[] {
	let rest = words;
	for (;;) {
		const [first] = rest;
		if (first === undefined) return rest;
		if (COMMAND_PREFIX_WORDS.has(first)) {
			rest = rest.slice(1);
			continue;
		}
		if (ASSIGNMENT_WORD.test(first)) {
			prefix.push(first);
			rest = rest.slice(1);
			continue;
		}
		const wrapper = basename(first);
		const takesArgument = WRAPPERS.get(wrapper);
		if (takesArgument) {
			prefix.push(wrapper);
			rest = rest.slice(1);
			// Wrapper options (with the argument some take) and the timeout's duration.
			while (
				rest[0] !== undefined &&
				(rest[0].startsWith("-") ||
					DURATION.test(rest[0]) ||
					ASSIGNMENT_WORD.test(rest[0]))
			) {
				const option = rest[0];
				rest = rest.slice(1);
				if (wrapper === "xargs") {
					const replace = xargsReplace(option, rest[0]);
					if (replace !== undefined) prefix.push(`xargs -I ${replace}`);
				}
				if (!takesArgument.has(option)) continue;
				if (wrapper === "env" && /^(-S|--split-string)/.test(option))
					prefix.push("env -S");
				rest = rest.slice(1);
			}
			continue;
		}
		return rest;
	}
}
