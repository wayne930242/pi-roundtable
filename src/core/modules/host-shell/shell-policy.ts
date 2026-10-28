import { basename } from "node:path";
import type { HoldContext, HoldRule } from "../../holds.ts";
import type { PushPolicy } from "./git-push.ts";
import { COMMAND_PREFIX_WORDS, lexShell } from "./shell-lexer.ts";
import {
	deviceTarget,
	expand,
	follow,
	type LineState,
	lineState,
	rmHeld,
	writable,
} from "./shell-paths.ts";
import { type Held, type ShellClass, verbHeld } from "./shell-programs.ts";

export type { PushPolicy } from "./git-push.ts";
export { simpleCommands } from "./shell-lexer.ts";
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
	"builtin",
	"xargs",
	"setsid",
	"unbuffer",
	"caffeinate",
]);

/**
 * Drops leading variable assignments, wrappers, and their options, leaving the real program;
 * `prefix` collects what was dropped.
 */
function program(words: string[], prefix: string[] = []): string[] {
	let rest = words;
	for (;;) {
		const [first] = rest;
		if (first === undefined) return rest;
		if (COMMAND_PREFIX_WORDS.has(first)) {
			rest = rest.slice(1);
			continue;
		}
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

/** The words the lexer gives a redirection operator. */
const REDIRECTS: ReadonlySet<string> = new Set(["<", ">", ">>", "dup"]);

/** Why a command whose name is not known until it runs is held. */
const DYNAMIC_NAME: Held = {
	reason: "a command whose name is built at run time",
	class: "shell.unreadable",
};

/**
 * The program a command word names, or undefined when the word expands to more than the line says:
 * a variable not known, a substitution, a brace expansion or a pattern (`$cmd`, `{sudo,ls}`,
 * `/usr/bin/sud*`).
 */
function commandName(word: string, state: LineState): string | undefined {
	// `[` and `[[` are the test commands, not patterns.
	if (word !== "[" && word !== "[[" && /[*?[]/.test(word)) return undefined;
	if (/\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(word)) return undefined;
	return word.includes("$") || word.includes("`") ? expand(word, state) : word;
}

/** Shells that run the command given with `-c`. */
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash"]);

/** The command a shell runs from its arguments (`-c`, also in a cluster such as `-ec`), if it is given one. */
function shellScript(args: readonly string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "-o" || arg === "+o" || arg === "-O" || arg === "+O") i++;
		else if (/^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) return args[i + 1] ?? "";
		else if (!/^[-+]/.test(arg) || arg === "--") return undefined;
	}
	return undefined;
}

/** The command `find` runs for each match (`-exec`, `-execdir`, `-ok`, `-okdir`), up to its `;` or `+`. */
function findExec(args: readonly string[]): string[] | undefined {
	const at = args.findIndex((arg) => /^-(exec|execdir|ok|okdir)$/.test(arg));
	if (at === -1) return undefined;
	const rest = args.slice(at + 1);
	const stop = rest.findIndex((arg) => arg === ";" || arg === "+");
	return stop === -1 ? rest : rest.slice(0, stop);
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
				found.push({
					reason: `writes to ${target}`,
					class: deviceTarget(target, state) ? "shell.disk" : "shell.write",
				});
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
		// A redirection is no part of the command: not its operator, its target, nor the descriptor
		// number in front (`3>&1 sudo ls` runs `sudo`).
		words.filter(
			(w, i) =>
				!REDIRECTS.has(w) &&
				!REDIRECTS.has(words[i - 1] ?? "") &&
				!(/^\d+$/.test(w) && REDIRECTS.has(words[i + 1] ?? "")),
		),
		prefix,
	);
	const [word, ...args] = argv;
	if (!word) return [];
	const head = commandName(word, state);
	if (head === undefined) return [DYNAMIC_NAME];
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
	if (name === "eval") {
		// What eval runs is its arguments after expansion: all of them must be known.
		const known = args.map((arg) => expand(arg, state));
		return known.includes(undefined)
			? [DYNAMIC_SCRIPT]
			: commandHeld(known.join(" "), state, policy);
	}
	if (SHELLS.has(name)) {
		const script = shellScript(args);
		if (script !== undefined) return scriptHeld(script, state, policy);
	}
	if (name === "find") {
		const exec = findExec(args);
		if (exec) return programHeld(exec, state, policy);
	}
	const held = verbHeld(name, args, prefix, state, policy);
	return held ? [held] : [];
}

/** Why a line the lexer could not read is held. */
const UNREADABLE: Held = {
	reason: "the command line is too long or too nested to check",
	class: "shell.unreadable",
};

/**
 * Why a script another shell runs (`bash -c`) is held. A script with a substitution, or one that
 * is a variable, is built from output not known here, so it is held whole.
 */
function scriptHeld(
	script: string,
	state: LineState,
	policy: PushPolicy,
): Held[] {
	if (/\$\(|`/.test(script)) return [DYNAMIC_SCRIPT];
	if (script.trimStart().startsWith("$")) {
		const known = expand(script, state);
		return known === undefined
			? [DYNAMIC_SCRIPT]
			: commandHeld(known, state, policy);
	}
	return commandHeld(script, state, policy);
}

const DYNAMIC_SCRIPT: Held = {
	reason: "a script built at run time",
	class: "shell.unreadable",
};

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
	const lexed = lexShell(command);
	// A line the lexer cannot read could run anything.
	if (lexed.unreadable) return [UNREADABLE];
	const found: Held[] = [];
	for (const words of lexed.commands) {
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

/**
 * What a shell call is held for, in words, and the class of every command it is held for. A
 * classifier that fails holds the call: no error lets a command run unjudged.
 */
function shellHold(
	toolName: string,
	input: Record<string, unknown>,
	context: HoldContext & { workspace: string },
	policy: PushPolicy,
): { action: string; classes: ShellClass[] } | undefined {
	try {
		return judge(toolName, input, context, policy);
	} catch {
		if (!SHELL_TOOLS.includes(toolName as (typeof SHELL_TOOLS)[number]))
			return undefined;
		let detail = `the ${toolName} call`;
		try {
			if (toolName === "bash" && typeof input.command === "string")
				detail = `the shell command \`${input.command.slice(0, MAX_SHOWN_COMMAND)}\``;
		} catch {
			// The input itself cannot be read; the call is held without showing it.
		}
		return {
			action: `run ${detail} on the host (it could not be checked)`,
			classes: ["shell.unreadable"],
		};
	}
}

function judge(
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
