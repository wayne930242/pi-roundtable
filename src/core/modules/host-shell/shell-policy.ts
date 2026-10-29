import { basename } from "node:path";
import type { HoldContext, HoldRule } from "../../holds.ts";
import type { PushPolicy } from "./git-push.ts";
import { COMMAND_PREFIX_WORDS, EXPANDED, lexShell } from "./shell-lexer.ts";
import {
	bindingCounts,
	deviceTarget,
	expand,
	expandName,
	follow,
	forgetRebound,
	type LineState,
	lineState,
	rmHeld,
	writable,
} from "./shell-paths.ts";
import { type Held, type ShellClass, verbHeld } from "./shell-programs.ts";
import {
	readsUnseenScript,
	recordWrites,
	SHELLS,
	shellScript,
	teeOperands,
} from "./shell-scripts.ts";
import {
	ASSIGNMENT_WORD,
	program,
	replaceString,
	WRAPPERS,
} from "./shell-wrappers.ts";

export type { PushPolicy } from "./git-push.ts";
export { simpleCommands } from "./shell-lexer.ts";
export { YOLO_CARDED_SHELL_CLASSES } from "./shell-programs.ts";

const MAX_SHOWN_COMMAND = 120;

/**
 * The command as a card's sentence shows it: its first line, cut to a length, in one code span.
 * The card shows the whole command beside it; a second line or a backtick here would break the
 * sentence's Markdown (a `# comment` line reads as a heading).
 */
function shownCommand(command: string): string {
	const [line = ""] = command.trim().split("\n", 1);
	const cut = line.length > MAX_SHOWN_COMMAND;
	const more = cut || line.length < command.trim().length;
	const shown = (cut ? line.slice(0, MAX_SHOWN_COMMAND) : line)
		.replaceAll("`", "'")
		.trimEnd();
	return more ? `${shown} …` : shown;
}

/** Pi's built-in shell and file tools, which agent sessions activate. */
export const SHELL_TOOLS = Object.freeze([
	"bash",
	"read",
	"edit",
	"write",
] as const);

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
	return word.includes("$") || word.includes("`")
		? expandName(word, state)
		: word;
}

/** Variables whose value bash runs as a command or expands with substitutions on its own. */
const SELF_RUNNING_VARIABLE =
	/^(?:PROMPT_COMMAND|PS[0124]|BASH_ENV|ENV|SHELLOPTS|BASH_ALIASES\[.*\])\+?=/;

/** Builtins whose arguments can be assignments. */
const ASSIGNING = new Set([
	"export",
	"declare",
	"typeset",
	"local",
	"readonly",
	"env",
]);

/**
 * Whether the command sets a variable that makes a shell run something later: before the command
 * (`PS4='$(x)' bash -x`) or as an argument of `export`, `declare` and the like.
 */
function setsSelfRunningVariable(words: readonly string[]): boolean {
	for (const word of words) {
		if (SELF_RUNNING_VARIABLE.test(word)) return true;
		const name = basename(word);
		if (
			!/^[A-Za-z_][A-Za-z0-9_]*(?:\[.*\])?\+?=/.test(word) &&
			!word.startsWith("-") &&
			!COMMAND_PREFIX_WORDS.has(word) &&
			!WRAPPERS.has(name) &&
			!ASSIGNING.has(name)
		)
			return false;
	}
	return false;
}

/** Builtins whose arguments can name a variable with a subscript, such as `a[$(x)]`, which bash evaluates. */
const SUBSCRIPT_EVALUATORS = new Set([
	"declare",
	"typeset",
	"local",
	"readonly",
	"export",
	"printf",
	"read",
	"unset",
	"mapfile",
	"readarray",
	"getopts",
	"wait",
	"test",
	"[",
	"[[",
	"let",
]);

/** The script a `trap` command installs, or undefined when it only lists or clears traps. */
function trapScript(args: readonly string[]): string | undefined {
	const rest = [...args];
	while (rest[0]?.startsWith("-")) if (rest.shift() === "--") break;
	const [script] = rest;
	return rest.length > 1 && script !== "" && script !== "-"
		? script
		: undefined;
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
	// A redirection is no part of the command: not its operator nor its target.
	const own = words.filter(
		(w, i) => !REDIRECTS.has(w) && !REDIRECTS.has(words[i - 1] ?? ""),
	);
	const argv = program(own, prefix);
	// A prompt or a startup file that runs a command needs no command word of its own
	// (`PS4='$(x)'; set -x`), and `env -S` splits its argument into a command line.
	if (setsSelfRunningVariable(own) || prefix.includes("env -S"))
		return [DYNAMIC_SCRIPT];
	const [word, ...args] = argv;
	// `xargs env` runs what its input says.
	if (!word)
		return prefix.includes("xargs") && prefix.at(-1) !== "xargs"
			? [DYNAMIC_SCRIPT]
			: [];
	const head = commandName(word, state);
	if (head === undefined) {
		// A variable the line binds may be empty when bash gets there, so the name is unknown; what
		// the line gives it is still judged, so the card says what it would run.
		const guess = word.includes("$") ? expand(word, state) : undefined;
		return [
			...(guess === undefined
				? []
				: programHeld([guess, ...args], state, policy)),
			DYNAMIC_NAME,
		];
	}
	const name = basename(head);
	// A command or a script `xargs` fills in from its input, or one the line does not show.
	const replace = replaceString(prefix);
	if (
		(replace !== undefined &&
			(word.includes(replace) ||
				(SHELLS.has(name) && args.some((arg) => arg.includes(replace))))) ||
		readsUnseenScript(word, name, args, prefix, state)
	)
		return [DYNAMIC_SCRIPT];
	// `mapfile -C` runs a callback for every chunk it reads.
	if (
		(name === "mapfile" || name === "readarray") &&
		args.some((arg) => /^-[A-Za-z]*C/.test(arg))
	)
		return [DYNAMIC_SCRIPT];
	// A builtin that takes a name evaluates a subscript in it, and that runs a substitution.
	if (
		SUBSCRIPT_EVALUATORS.has(name) &&
		args.some((arg) => /\[[^\]]*(?:\$\(|`)/.test(arg))
	)
		return [DYNAMIC_SCRIPT];
	// An alias names a command at run time; `expand_aliases` is what lets a script use one.
	if (name === "alias" && args.some((arg) => arg.includes("=")))
		return [DYNAMIC_NAME];
	if (name === "trap") {
		const script = trapScript(args);
		if (script !== undefined) return scriptHeld(script, state, policy);
	}
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
		const known = args.map((arg) => expandName(arg, state));
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

/** Whether a simple command evaluates arithmetic without `(( ))`: `let`, `declare -i`, `[[ a -eq b ]]`. */
function evaluatesArithmetic(words: readonly string[]): boolean {
	const [first] = words;
	if (first === "let") return true;
	if (first === "declare" || first === "typeset" || first === "local")
		return words.some((word) => /^-[A-Za-z]*i/.test(word));
	return (
		first === "[[" &&
		words.some((word) => /^-(?:eq|ne|lt|gt|le|ge)$/.test(word))
	);
}

/** Why a line the lexer could not read is held. */
const UNREADABLE: Held = {
	reason: "the command line is too long or too nested to check",
	class: "shell.unreadable",
};

/**
 * Why a script another shell runs (`bash -c`) is held. A script with a substitution the outer shell
 * expands, or one that is a variable, is built from output not known here, so it is held whole. A
 * substitution the outer shell leaves alone (single quotes) is the inner shell's, and judged as one.
 */
function scriptHeld(
	script: string,
	state: LineState,
	policy: PushPolicy,
): Held[] {
	if (script.includes(EXPANDED)) return [DYNAMIC_SCRIPT];
	if (script.trimStart().startsWith("$")) {
		const known = expandName(script, state);
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
		written: new Set(outer.written),
		bound: new Set([
			...outer.bound,
			...lineState(command, outer.workspace, undefined).bound,
		]),
		roots: outer.roots,
		vars: new Map(outer.vars),
		cwd: outer.cwd,
	};
	const lexed = lexShell(command);
	// A line the lexer cannot read could run anything.
	if (lexed.unreadable) return [UNREADABLE];
	const found: Held[] = [];
	// Arithmetic evaluates a `$(` in the value of a variable, text this rule cannot follow.
	if (
		lexed.literalSubstitution &&
		(lexed.arithmetic || lexed.commands.some(evaluatesArithmetic))
	)
		found.push(DYNAMIC_SCRIPT);
	let counts: Map<string, number> | undefined;
	for (const words of lexed.commands) {
		found.push(...heldReasons(words, state, policy));
		const [first, ...rest] = program(words);
		recordWrites(words, first ? teeOperands(first, rest) : [], state);
		follow(program(words), state);
		// `export` and `cd` are kept by program(); bare assignments are dropped by it.
		if (words.every((w) => ASSIGNMENT_WORD.test(w))) follow(words, state);
		counts ??= bindingCounts(command);
		forgetRebound(words, state, counts);
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
				detail = `the shell command \`${shownCommand(input.command)}\``;
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
					action: `run the shell command \`${shownCommand(command)}\` on the host (${first.reason})`,
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
