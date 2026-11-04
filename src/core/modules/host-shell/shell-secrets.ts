import { homedir } from "node:os";
import { basename } from "node:path";
import type { PushPolicy } from "./git-push.ts";
import { type LineState, resolvePath } from "./shell-paths.ts";
import type { Held, ShellClass } from "./shell-programs.ts";

/** What the shell rule lets run: its push policy, and the files that hold secrets. */
export interface ShellPolicy extends PushPolicy {
	/**
	 * More files whose reading is held as `shell.secret-read`, on top of `DEFAULT_SECRET_PATHS`, as
	 * the same globs: a pattern with no `/` matches a file name anywhere, `~/` is the home
	 * directory, `**` crosses directories, and a leading `!` lets a match run.
	 */
	secretPaths?: readonly string[];
}

/**
 * The files whose reading is held as `shell.secret-read`: environment files, ssh and gh logins, git,
 * curl and PostgreSQL credentials, Pi's model logins, and a process's environment. Example env
 * files (`.env.example`) run.
 */
export const DEFAULT_SECRET_PATHS: readonly string[] = Object.freeze([
	"/proc/*/environ",
	"/proc/self/environ",
	"*.env",
	".env*",
	"!.env.example",
	"!.env.sample",
	"!.env.template",
	"~/.ssh/**",
	"~/.config/gh/**",
	".git-credentials",
	".netrc",
	".pgpass",
	"~/.pi/**/auth.json",
]);

const SECRET_READ: ShellClass = "shell.secret-read";

/** A glob as a regular expression over a whole path, or over a file name when it has no `/`. */
function globPattern(glob: string): { name: boolean; pattern: RegExp } {
	const name = !glob.includes("/");
	const path = glob.startsWith("~/")
		? `${homedir()}${glob.slice(1)}`
		: name || glob.startsWith("/")
			? glob
			: `**/${glob}`;
	let source = "";
	for (let i = 0; i < path.length; i++) {
		const ch = path[i] as string;
		// A trailing `/**` takes the directory itself too, as `tar ~/.ssh` reads all of it.
		if (i === path.length - 3 && path.endsWith("/**")) {
			source += "(?:/.*)?";
			break;
		}
		if (path.startsWith("**/", i)) {
			source += "(?:.*/)?";
			i += 2;
		} else if (path.startsWith("**", i)) {
			source += ".*";
			i += 1;
		} else if (ch === "*") source += "[^/]*";
		else if (ch === "?") source += "[^/]";
		else source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return { name, pattern: new RegExp(`^${source}$`) };
}

interface SecretGlobs {
	held: { name: boolean; pattern: RegExp }[];
	allowed: { name: boolean; pattern: RegExp }[];
}

const compiled = new WeakMap<readonly string[], SecretGlobs>();

function secretGlobs(extra: readonly string[] | undefined): SecretGlobs {
	const key = extra ?? DEFAULT_SECRET_PATHS;
	const known = compiled.get(key);
	if (known) return known;
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	const globs = [
		...DEFAULT_SECRET_PATHS,
		...(agentDir ? [`${agentDir.replace(/\/+$/, "")}/auth.json`] : []),
		...(extra ?? []),
	];
	const made: SecretGlobs = {
		held: globs.filter((g) => !g.startsWith("!")).map(globPattern),
		allowed: globs
			.filter((g) => g.startsWith("!"))
			.map((g) => globPattern(g.slice(1))),
	};
	compiled.set(key, made);
	return made;
}

/** Whether a path matches one of the globs. */
function matchesAny(
	path: string,
	globs: readonly { name: boolean; pattern: RegExp }[],
): boolean {
	return globs.some(({ name, pattern }) =>
		pattern.test(name ? basename(path) : path),
	);
}

/** The paths an argument may name: itself, the value of `--opt=value`, and a curl `@file` or `field=@file`. */
function candidates(arg: string): string[] {
	const found = [arg];
	const eq = arg.indexOf("=");
	if (arg.startsWith("-") && eq !== -1) found.push(arg.slice(eq + 1));
	const at = arg.indexOf("@");
	if (at !== -1 && (at === 0 || arg[at - 1] === "=" || arg.startsWith("-")))
		found.push(arg.slice(at + 1).replace(/;.*$/, ""));
	return found.filter((path) => path !== "");
}

/** The secret file an argument names, or undefined. */
export function secretFile(
	arg: string,
	state: LineState,
	policy: ShellPolicy,
): string | undefined {
	const globs = secretGlobs(policy.secretPaths);
	for (const word of candidates(arg)) {
		const path = resolvePath(word, state);
		if (path === undefined) continue;
		if (matchesAny(path, globs.held) && !matchesAny(path, globs.allowed))
			return word;
	}
	return undefined;
}

/** Why a redirect from `source` (`< file`) is held: it reads a secret file. */
export function secretRedirect(
	source: string | undefined,
	state: LineState,
	policy: ShellPolicy,
): Held | undefined {
	const file =
		source === undefined ? undefined : secretFile(source, state, policy);
	return file === undefined
		? undefined
		: { reason: `reads the secret file ${file}`, class: SECRET_READ };
}

/** What a call of Pi's read tool is held for: a file that holds a secret. */
export function secretReadHeld(
	input: Record<string, unknown>,
	state: LineState,
	policy: ShellPolicy,
): { action: string; classes: ShellClass[] } | undefined {
	const path = typeof input.path === "string" ? input.path : "";
	return secretFile(path.replace(/^@/, ""), state, policy) === undefined
		? undefined
		: {
				action: `read the secret file ${path} on the host`,
				classes: [SECRET_READ],
			};
}

/** Why an `env` with no command is held: it prints the environment. */
export const ENV_PRINTED: Held = Object.freeze({
	reason: "prints the environment",
	class: SECRET_READ,
});

/** Programs that read the files they are given, or send them on: their path arguments are checked. */
const READERS = new Set([
	"cat",
	"tac",
	"less",
	"more",
	"most",
	"bat",
	"batcat",
	"head",
	"tail",
	"nl",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ag",
	"sed",
	"awk",
	"gawk",
	"mawk",
	"cut",
	"sort",
	"uniq",
	"paste",
	"diff",
	"cmp",
	"od",
	"xxd",
	"hexdump",
	"strings",
	"base64",
	"base32",
	"cp",
	"mv",
	"rsync",
	"scp",
	"tar",
	"zip",
	"gzip",
	"bzip2",
	"xz",
	"zstd",
	"7z",
	"curl",
	"wget",
	"jq",
	"yq",
	"source",
	".",
	"vi",
	"vim",
	"view",
	"nano",
	"openssl",
	"gpg",
	"split",
]);

/** Why a read of a secret file by `name` with `args` is held, or undefined. */
export function secretFileRead(
	name: string,
	args: readonly string[],
	state: LineState,
	policy: ShellPolicy,
): Held | undefined {
	if (!READERS.has(name)) return undefined;
	for (const arg of args) {
		const file = secretFile(arg, state, policy);
		if (file !== undefined)
			return { reason: `reads the secret file ${file}`, class: SECRET_READ };
	}
	return undefined;
}

/** Why a command that prints the environment, or a stored credential, is held; undefined when it does not. */
export function secretPrinted(
	name: string,
	args: readonly string[],
): Held | undefined {
	const flags = args.filter((a) => a.startsWith("-"));
	const operands = args.filter((a) => !a.startsWith("-"));
	const prints = (reason: string): Held => ({ reason, class: SECRET_READ });
	switch (name) {
		case "printenv":
			return prints("prints the environment");
		case "export":
			return operands.length === 0 || flags.includes("-p")
				? prints("prints the environment")
				: undefined;
		case "declare":
		case "typeset":
			return flags.some((f) => /^-[A-Za-z]*p/.test(f)) ||
				(operands.length === 0 && !flags.some((f) => /^-[A-Za-z]*[fF]/.test(f)))
				? prints("prints the variables")
				: undefined;
		case "set":
			return args.length === 0 ? prints("prints the variables") : undefined;
		case "compgen":
			return args.some(
				(a, i) =>
					a === "-e" ||
					a === "-v" ||
					(args[i - 1] === "-A" && (a === "variable" || a === "export")),
			)
				? prints("lists the environment")
				: undefined;
		default:
			return undefined;
	}
}

/** Why a `gh` command that prints its token is held. */
export function ghTokenPrinted(args: readonly string[]): Held | undefined {
	const [group, verb] = args.filter((a) => !a.startsWith("-"));
	if (group !== "auth") return undefined;
	if (verb === "token")
		return { reason: "prints the GitHub token", class: SECRET_READ };
	if (
		verb === "status" &&
		args.some((a) => a === "--show-token" || /^-[A-Za-z]*t/.test(a))
	)
		return { reason: "prints the GitHub token", class: SECRET_READ };
	return undefined;
}

/** Why a git subcommand that reads stored credentials is held: `git credential`, a credential helper, `git config` of `credential.*`. */
export function gitCredentialRead(
	verb: string | undefined,
	rest: readonly string[],
): Held | undefined {
	if (verb?.startsWith("credential"))
		return { reason: "reads git credentials", class: SECRET_READ };
	if (
		verb === "config" &&
		rest.some((a) => /credential/i.test(a) || a === "-l" || a === "--list")
	)
		return { reason: "reads git credentials", class: SECRET_READ };
	return undefined;
}
