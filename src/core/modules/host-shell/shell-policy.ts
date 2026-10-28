import { basename } from "node:path";
import type { HoldContext, HoldRule } from "../../holds.ts";
import type { PushPolicy } from "./git-push.ts";
import {
	follow,
	type LineState,
	lineState,
	rmHeld,
	writable,
} from "./shell-paths.ts";
import { type Held, type ShellClass, verbHeld } from "./shell-programs.ts";

export type { PushPolicy } from "./git-push.ts";
export { YOLO_CARDED_SHELL_CLASSES } from "./shell-programs.ts";

const MAX_SHOWN_COMMAND = 600;

/** Pi's built-in shell and file tools, which agent sessions activate. */
export const SHELL_TOOLS = Object.freeze([
	"bash",
	"read",
	"edit",
	"write",
] as const);

/** Words that run the next word as the command. */
const WRAPPERS = new Set([
	"env",
	"nohup",
	"time",
	"nice",
	"ionice",
	"timeout",
	"stdbuf",
	"exec",
	"command",
	"xargs",
]);

/** Splits a command line into simple commands of words; quotes are removed, operators separate. */
export function simpleCommands(command: string): string[][] {
	const commands: string[][] = [];
	let words: string[] = [];
	let word = "";
	let inWord = false;
	let quote: "'" | '"' | undefined;
	const endWord = () => {
		if (inWord) words.push(word);
		word = "";
		inWord = false;
	};
	const endCommand = () => {
		endWord();
		if (words.length > 0) commands.push(words);
		words = [];
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i] as string;
		if (quote) {
			if (ch === quote) quote = undefined;
			else if (ch === "\\" && quote === '"' && i + 1 < command.length) {
				word += command[++i];
			} else word += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			inWord = true;
		} else if (ch === "\\" && i + 1 < command.length) {
			word += command[++i];
			inWord = true;
		} else if (/\s/.test(ch)) {
			if (ch === "\n") endCommand();
			else endWord();
		} else if (";&|()`{}".includes(ch)) {
			// A word cut by a command substitution keeps its mark, so its value counts as unknown.
			if (ch === "`" && inWord) word += ch;
			endCommand();
		} else if (ch === "$" && command[i + 1] === "(") {
			if (inWord) word += "$(";
			endCommand();
			i++;
		} else if (ch === ">" || ch === "<") {
			// Redirections become their own words, so their targets can be checked.
			endWord();
			let op = ch;
			if (command[i + 1] === ">") op += command[++i];
			if (command[i + 1] === "&") {
				// `>&2` duplicates a descriptor rather than naming a file.
				i++;
				op = "dup";
			}
			words.push(op);
		} else {
			word += ch;
			inWord = true;
		}
	}
	endCommand();
	return commands;
}

/**
 * Drops leading variable assignments, wrappers, and their options, leaving the real program;
 * `prefix` collects what was dropped.
 */
function program(words: string[], prefix: string[] = []): string[] {
	let rest = words;
	for (;;) {
		const [first] = rest;
		if (first === undefined) return rest;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
			prefix.push(first);
			rest = rest.slice(1);
			continue;
		}
		if (WRAPPERS.has(basename(first))) {
			prefix.push(basename(first));
			rest = rest.slice(1);
			// Wrapper options and the timeout's duration.
			while (
				rest[0] !== undefined &&
				(rest[0].startsWith("-") ||
					/^\d+[smhd]?$/.test(rest[0]) ||
					/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]))
			)
				rest = rest.slice(1);
			continue;
		}
		return rest;
	}
}

/** The class of each program that is held whatever its arguments. */
const ALWAYS_HELD_CLASS: ReadonlyMap<string, ShellClass> = new Map([
	["sudo", "shell.privilege"],
	["su", "shell.privilege"],
	["doas", "shell.privilege"],
	["dd", "shell.disk"],
	["shutdown", "shell.power"],
	["reboot", "shell.power"],
	["poweroff", "shell.power"],
	["halt", "shell.power"],
	["kill", "shell.kill"],
	["pkill", "shell.kill"],
	["killall", "shell.kill"],
]);

/** Every reason one simple command is held, the redirections first; reads the line's state as it is before it. */
function heldReasons(
	words: string[],
	state: LineState,
	policy: PushPolicy,
): Held[] {
	const found: Held[] = [];
	for (let i = 0; i < words.length; i++) {
		const op = words[i];
		if (op === ">" || op === ">>") {
			const target = words[i + 1];
			if (target && !writable(target, state))
				found.push({ reason: `writes to ${target}`, class: "shell.write" });
		}
	}
	return [...found, ...programHeld(words, state, policy)];
}

/** Why the program a simple command runs is held, apart from its redirections. */
function programHeld(
	words: string[],
	state: LineState,
	policy: PushPolicy,
): Held[] {
	const prefix: string[] = [];
	const argv = program(
		words.filter(
			(w, i) =>
				!["<", ">", ">>", "dup"].includes(w) &&
				!["<", ">", ">>"].includes(words[i - 1] ?? ""),
		),
		prefix,
	);
	const [head, ...args] = argv;
	if (!head) return [];
	const name = basename(head);
	const always = ALWAYS_HELD_CLASS.get(name);
	if (always) return [{ reason: name, class: always }];
	if (/^mkfs(\..+)?$/.test(name))
		return [{ reason: name, class: "shell.disk" }];
	if (name === "rm") {
		// xargs adds operands nobody can see here.
		const reason = prefix.includes("xargs") ? "rm" : rmHeld(args, state);
		return reason ? [{ reason, class: "shell.rm" }] : [];
	}
	if ((name === "bash" || name === "sh" || name === "zsh") && args[0] === "-c")
		return commandHeld(args[1] ?? "", state, policy);
	const held = verbHeld(name, args, prefix, state, policy);
	return held ? [held] : [];
}

/** Every reason a command line is held, command by command; a `bash -c` inside one starts from the outer line's state. */
function commandHeld(
	command: string,
	outer: LineState,
	policy: PushPolicy,
): Held[] {
	const state: LineState = {
		...lineState(command, outer.workspace, undefined),
		roots: outer.roots,
		vars: new Map(outer.vars),
		cwd: outer.cwd,
	};
	const found: Held[] = [];
	for (const words of simpleCommands(command)) {
		found.push(...heldReasons(words, state, policy));
		follow(program(words), state);
		// `export` and `cd` are kept by program(); bare assignments are dropped by it.
		if (words.every((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)))
			follow(words, state);
	}
	return found;
}

/**
 * Pi's shell and file tools: a bash command that is destructive or reaches outside the scratch
 * roots (the shared workspace and the scratch dir), and a write or edit outside them, wait for the
 * owner. Reading always runs.
 */
export function shellActionNeedingConfirmation(
	toolName: string,
	input: Record<string, unknown>,
	context: HoldContext & { workspace: string },
	policy: PushPolicy = {},
): string | undefined {
	return shellHold(toolName, input, context, policy)?.action;
}

/** What a shell call is held for, in words, and the class of every command it is held for. */
function shellHold(
	toolName: string,
	input: Record<string, unknown>,
	context: HoldContext & { workspace: string },
	policy: PushPolicy,
): { action: string; classes: ShellClass[] } | undefined {
	const state = lineState(
		typeof input.command === "string" ? input.command : "",
		context.workspace,
		context.scratchDir,
	);
	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		const found = commandHeld(command, state, policy);
		const [first] = found;
		return first
			? {
					action: `run the shell command \`${command.slice(0, MAX_SHOWN_COMMAND)}\` on the host (${first.reason})`,
					classes: [...new Set(found.map((held) => held.class))],
				}
			: undefined;
	}
	if (toolName === "write" || toolName === "edit") {
		const path = typeof input.path === "string" ? input.path : "";
		return writable(path.replace(/^@/, ""), state)
			? undefined
			: {
					action: `${toolName} the file ${path} on the host`,
					classes: ["shell.write"],
				};
	}
	return undefined;
}

/**
 * The shell rule with a push policy: a plain push to a repository of `ownPushOwners`, other than
 * `heldPushRepos`, runs without a hold. Shell calls of a session without a workspace have no shell.
 */
export function shellHoldRuleFor(policy: PushPolicy = {}): Readonly<HoldRule> {
	const frozen: PushPolicy = {
		ownPushOwners: [...(policy.ownPushOwners ?? [])],
		heldPushRepos: [...(policy.heldPushRepos ?? [])],
	};
	return Object.freeze<HoldRule>({
		name: "shell",
		describe: (tool, input, context) =>
			context.workspace === undefined
				? undefined
				: shellActionNeedingConfirmation(
						tool,
						input,
						{ ...context, workspace: context.workspace },
						frozen,
					),
		holdClasses: (tool, input, context) =>
			context.workspace === undefined
				? undefined
				: shellHold(
						tool,
						input,
						{ ...context, workspace: context.workspace },
						frozen,
					)?.classes,
	});
}

/** The strict shell rule: every push is held. */
export const shellHoldRule: Readonly<HoldRule> = shellHoldRuleFor();
