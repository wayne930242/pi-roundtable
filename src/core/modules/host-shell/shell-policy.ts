import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { HoldRule } from "../../holds.ts";
import { assistantName } from "../../i18n/index.ts";

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
	"rm",
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

/** A path is inside the workspace when it resolves under it; `~` means the service user's home. */
function insideWorkspace(path: string, workspace: string): boolean {
	const expanded =
		path === "~" || path.startsWith("~/")
			? `${homedir()}${path.slice(1)}`
			: path;
	const target = resolve(workspace, expanded);
	const rel = relative(resolve(workspace), target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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
			endCommand();
		} else if (ch === "$" && command[i + 1] === "(") {
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

/** Drops leading variable assignments, wrappers, and their options, leaving the real program. */
function program(words: string[]): string[] {
	let rest = words;
	for (;;) {
		const [first] = rest;
		if (first === undefined) return rest;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
			rest = rest.slice(1);
			continue;
		}
		if (WRAPPERS.has(basename(first))) {
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

/** Why one simple command is held, or undefined. */
function heldReason(words: string[], workspace: string): string | undefined {
	for (let i = 0; i < words.length; i++) {
		const op = words[i];
		if (op === ">" || op === ">>") {
			const target = words[i + 1];
			if (
				target &&
				target !== "/dev/null" &&
				!insideWorkspace(target, workspace)
			)
				return `writes to ${target}`;
		}
	}
	const argv = program(
		words.filter(
			(w, i) =>
				!["<", ">", ">>", "dup"].includes(w) &&
				!["<", ">", ">>"].includes(words[i - 1] ?? ""),
		),
	);
	const [head, ...args] = argv;
	if (!head) return undefined;
	const name = basename(head);
	if (ALWAYS_HELD.has(name) || /^mkfs(\..+)?$/.test(name)) return name;
	if ((name === "bash" || name === "sh" || name === "zsh") && args[0] === "-c")
		return commandHeld(args[1] ?? "", workspace);
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
			const [verb, ...rest] = gitCommand(args);
			if (verb === "push")
				return rest.some((a) => a === "-f" || a.startsWith("--force"))
					? "force-pushes"
					: `pushes to GitHub, which deploys ${assistantName()} when the branch is main`;
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
				(a) => !a.startsWith("-") && !insideWorkspace(a, workspace),
			);
			return target && target !== "/dev/null"
				? `writes to ${target}`
				: undefined;
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

/** The git subcommand and its arguments, past global options such as `-C <dir>`. */
function gitCommand(args: string[]): string[] {
	let i = 0;
	while (i < args.length && (args[i] as string).startsWith("-"))
		i += GIT_VALUE_OPTIONS.has(args[i] as string) ? 2 : 1;
	return args.slice(i);
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

function commandHeld(command: string, workspace: string): string | undefined {
	for (const words of simpleCommands(command)) {
		const reason = heldReason(words, workspace);
		if (reason) return reason;
	}
	return undefined;
}

/**
 * Pi's shell and file tools: a bash command that is destructive or reaches outside the shared
 * workspace, and a write or edit outside it, wait for the owner. Reading always runs.
 */
export function shellActionNeedingConfirmation(
	toolName: string,
	input: Record<string, unknown>,
	workspace: string,
): string | undefined {
	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		const reason = commandHeld(command, workspace);
		return reason
			? `run the shell command \`${command.slice(0, MAX_SHOWN_COMMAND)}\` on the host (${reason})`
			: undefined;
	}
	if (toolName === "write" || toolName === "edit") {
		const path = typeof input.path === "string" ? input.path : "";
		return insideWorkspace(path.replace(/^@/, ""), workspace)
			? undefined
			: `${toolName} the file ${path} on the host`;
	}
	return undefined;
}

/** Shell calls of a session with a workspace; sessions without one have no shell. */
export const shellHoldRule: Readonly<HoldRule> = Object.freeze<HoldRule>({
	name: "shell",
	describe: (tool, input, { workspace }) =>
		workspace === undefined
			? undefined
			: shellActionNeedingConfirmation(tool, input, workspace),
});
