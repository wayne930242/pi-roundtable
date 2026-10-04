import { basename } from "node:path";
import type { HoldContext, HoldRule } from "../../holds.ts";
import { assistantName } from "../../i18n/index.ts";
import { ownPush, type PushPolicy } from "./git-push.ts";
import {
	follow,
	insideRoots,
	type LineState,
	lineState,
	resolvePath,
	rmHeld,
} from "./shell-paths.ts";

export type { PushPolicy } from "./git-push.ts";

const MAX_SHOWN_COMMAND = 600;

/** Pi's built-in shell and file tools, which agent sessions activate. */
export const SHELL_TOOLS = Object.freeze([
	"bash",
	"read",
	"edit",
	"write",
] as const);

/** Programs that are held whatever their arguments. */
const ALWAYS_HELD = new Set([
	"sudo",
	"su",
	"doas",
	"dd",
	"shutdown",
	"reboot",
	"poweroff",
	"halt",
	"kill",
	"pkill",
	"killall",
]);
const SYSTEMD_VERBS = new Set([
	"start",
	"stop",
	"restart",
	"reload",
	"try-restart",
	"reload-or-restart",
	"enable",
	"disable",
	"mask",
	"unmask",
	"kill",
	"isolate",
]);
const DOCKER_VERBS = new Set(["stop", "kill", "restart", "rm", "rmi", "prune"]);
const DOCKER_OBJECTS = new Set([
	"container",
	"image",
	"volume",
	"network",
	"system",
	"builder",
]);
const COMPOSE_VERBS = new Set(["down", "stop", "kill", "restart", "rm"]);
const PACKAGE_VERBS = new Set([
	"install",
	"reinstall",
	"remove",
	"purge",
	"autoremove",
	"upgrade",
	"full-upgrade",
	"dist-upgrade",
]);
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

/**
 * Whether a write to the word stays inside a scratch root. A word the line cannot resolve is read
 * as written from the workspace, as before variables were followed.
 */
function writable(word: string, state: LineState): boolean {
	if (word === "/dev/null") return true;
	const path =
		resolvePath(word, state) ??
		resolvePath(word, { ...state, vars: new Map(), cwd: state.workspace }) ??
		word;
	return insideRoots(path, state);
}

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

/** Why one simple command is held, or undefined; reads the line's state as it is before it. */
function heldReason(
	words: string[],
	state: LineState,
	policy: PushPolicy,
): string | undefined {
	for (let i = 0; i < words.length; i++) {
		const op = words[i];
		if (op === ">" || op === ">>") {
			const target = words[i + 1];
			if (target && !writable(target, state)) return `writes to ${target}`;
		}
	}
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
	if (!head) return undefined;
	const name = basename(head);
	if (ALWAYS_HELD.has(name) || /^mkfs(\..+)?$/.test(name)) return name;
	if (name === "rm")
		// xargs adds operands nobody can see here.
		return prefix.includes("xargs") ? "rm" : rmHeld(args, state);
	if ((name === "bash" || name === "sh" || name === "zsh") && args[0] === "-c")
		return commandHeld(args[1] ?? "", state, policy);
	const verbs = args.filter((a) => !a.startsWith("-"));
	switch (name) {
		case "systemctl":
			return verbs.some((v) => SYSTEMD_VERBS.has(v))
				? "changes a systemd unit"
				: undefined;
		case "service":
			return verbs.some((v) =>
				["start", "stop", "restart", "reload"].includes(v),
			)
				? "changes a service"
				: undefined;
		case "docker": {
			const [first, second] = verbs;
			if (first === "compose")
				return second && COMPOSE_VERBS.has(second)
					? `docker compose ${second}`
					: undefined;
			if (first && DOCKER_VERBS.has(first)) return `docker ${first}`;
			if (
				first &&
				DOCKER_OBJECTS.has(first) &&
				second &&
				(DOCKER_VERBS.has(second) || second === "remove")
			)
				return `docker ${first} ${second}`;
			return undefined;
		}
		case "docker-compose":
			return verbs[0] && COMPOSE_VERBS.has(verbs[0])
				? `docker-compose ${verbs[0]}`
				: undefined;
		case "ufw":
			return verbs[0] === "status" || verbs.length === 0
				? undefined
				: "changes the firewall";
		case "iptables":
		case "ip6tables":
		case "nft":
			return args.some((a) => ["-L", "--list", "-S", "list"].includes(a))
				? undefined
				: "changes the firewall";
		case "apt":
		case "apt-get":
		case "snap":
			return verbs.some((v) => PACKAGE_VERBS.has(v))
				? "installs or removes packages"
				: undefined;
		case "dpkg":
			return args.some((a) =>
				["-i", "-r", "-P", "--install", "--remove", "--purge"].includes(a),
			)
				? "installs or removes packages"
				: undefined;
		case "git": {
			const [globals, [verb, ...rest]] = gitCommand(args);
			if (verb === "push") {
				const plain = !prefix.some((w) => w.startsWith("GIT_"));
				if (plain && ownPush(globals, rest, state, policy)) return undefined;
				return rest.some((a) => a === "-f" || a.startsWith("--force"))
					? "force-pushes"
					: `pushes to GitHub, which deploys ${assistantName()} when the branch is main`;
			}
			if (verb === "reset" && rest.includes("--hard"))
				return "git reset --hard";
			return undefined;
		}
		case "gh":
			return ghHeld(args);
		case "crontab":
			return args.includes("-r") ? "removes a crontab" : undefined;
		case "tee": {
			const target = args.find(
				(a) => !a.startsWith("-") && !writable(a, state),
			);
			return target ? `writes to ${target}` : undefined;
		}
		default:
			return undefined;
	}
}

/** Git's global options that take a value, as separate words. */
const GIT_VALUE_OPTIONS = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
]);

/** Git's global options, such as `-C <dir>`, and the subcommand with its arguments. */
function gitCommand(args: string[]): [string[], string[]] {
	let i = 0;
	while (i < args.length && (args[i] as string).startsWith("-"))
		i += GIT_VALUE_OPTIONS.has(args[i] as string) ? 2 : 1;
	return [args.slice(0, i), args.slice(i)];
}

const GH_BODY_FLAGS = ["-f", "-F", "--field", "--raw-field", "--input"];
const GH_READ_VERBS = new Set(["list", "view", "download"]);
const GH_REPO_CHANGES = new Set([
	"create",
	"delete",
	"edit",
	"rename",
	"archive",
	"unarchive",
]);

/** Why a `gh` command writes to GitHub in a way the owner approves, or undefined. */
function ghHeld(args: string[]): string | undefined {
	const [group, verb] = args.filter((a) => !a.startsWith("-"));
	switch (group) {
		case "pr":
			return verb === "merge" ? "merges a pull request" : undefined;
		case "api": {
			const body = args.some((a) =>
				GH_BODY_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)),
			);
			if (verb === "graphql")
				return args.some((a) => /\bmutation\b/.test(a))
					? "changes GitHub through the API"
					: undefined;
			const index = args.findIndex((a) => a === "-X" || a === "--method");
			const method = (
				index === -1
					? args.find((a) => a.startsWith("--method="))?.slice(9)
					: args[index + 1]
			)?.toUpperCase();
			return body || (method !== undefined && method !== "GET")
				? "changes GitHub through the API"
				: undefined;
		}
		case "release":
		case "secret":
		case "variable":
			return verb && !GH_READ_VERBS.has(verb)
				? `changes GitHub ${group}s`
				: undefined;
		case "repo":
			return verb && GH_REPO_CHANGES.has(verb)
				? `changes a GitHub repository (${verb})`
				: undefined;
		default:
			return undefined;
	}
}

/** Why a command line is held; a `bash -c` inside one starts from the outer line's state. */
function commandHeld(
	command: string,
	outer: LineState,
	policy: PushPolicy,
): string | undefined {
	const state: LineState = {
		...lineState(command, outer.workspace, undefined),
		roots: outer.roots,
		vars: new Map(outer.vars),
		cwd: outer.cwd,
	};
	for (const words of simpleCommands(command)) {
		const reason = heldReason(words, state, policy);
		if (reason) return reason;
		follow(program(words), state);
		// `export` and `cd` are kept by program(); bare assignments are dropped by it.
		if (words.every((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)))
			follow(words, state);
	}
	return undefined;
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
	const state = lineState(
		typeof input.command === "string" ? input.command : "",
		context.workspace,
		context.scratchDir,
	);
	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		const reason = commandHeld(command, state, policy);
		return reason
			? `run the shell command \`${command.slice(0, MAX_SHOWN_COMMAND)}\` on the host (${reason})`
			: undefined;
	}
	if (toolName === "write" || toolName === "edit") {
		const path = typeof input.path === "string" ? input.path : "";
		return writable(path.replace(/^@/, ""), state)
			? undefined
			: `${toolName} the file ${path} on the host`;
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
	});
}

/** The strict shell rule: every push is held. */
export const shellHoldRule: Readonly<HoldRule> = shellHoldRuleFor();
