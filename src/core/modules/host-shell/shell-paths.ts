import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";

/**
 * What the commands of one command line know as they are read in order: the variables assigned
 * earlier with literal values, and the directory the last `cd` moved to.
 */
export interface LineState {
	/** The shared workspace, where a command line starts. */
	workspace: string;
	/** Directories a command writes and removes in without a hold: the workspace and the scratch dir. */
	roots: readonly string[];
	/** Variables with known values; a name mapped to undefined was assigned something unknown. */
	vars: Map<string, string | undefined>;
	/** The working directory, or undefined once a `cd` went somewhere unknown. */
	cwd: string | undefined;
	/** The names the line itself writes anywhere, as a bare word: what it assigns, loops over or reads into. */
	bound: ReadonlySet<string>;
	/** The files the line has written so far with `>`, `>>` and `tee`, as it names them without a leading `./`. */
	written: Set<string>;
	/** Whether `cd` can be followed: false in a line with subshells or `||`, where the last `cd` may not apply. */
	followsCd: boolean;
}

export function lineState(
	command: string,
	workspace: string,
	scratchDir: string | undefined,
): LineState {
	const vars = new Map<string, string | undefined>([["HOME", homedir()]]);
	if (scratchDir !== undefined) vars.set("TMPDIR", scratchDir);
	return {
		workspace,
		roots: scratchDir === undefined ? [workspace] : [workspace, scratchDir],
		vars,
		cwd: workspace,
		written: new Set(),
		bound: new Set(bindingCounts(command).keys()),
		followsCd: !/(^|[^$])\(|\|\|/.test(command),
	};
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=(.*)$/s;

/**
 * The word with the line's variables substituted and `~` expanded, or undefined when it holds a
 * command substitution, an unknown variable, a brace expansion or `~user`.
 */
export function expand(word: string, state: LineState): string | undefined {
	if (word.includes("`") || word.includes("$(")) return undefined;
	let unknown = false;
	const substituted = word.replace(
		/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
		(_, braced: string | undefined, plain: string | undefined) => {
			const value = state.vars.get((braced ?? plain) as string);
			if (value === undefined) unknown = true;
			return value ?? "";
		},
	);
	if (unknown || substituted.includes("$")) return undefined;
	// A brace expansion (`{a,b}`, `{1..3}`) names several words.
	if (/\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(substituted)) return undefined;
	if (substituted === "~" || substituted.startsWith("~/"))
		return `${homedir()}${substituted.slice(1)}`;
	return substituted.startsWith("~") ? undefined : substituted;
}

/** The absolute path a word names, from the line's working directory; undefined when unknown. */
export function resolvePath(
	word: string,
	state: LineState,
): string | undefined {
	const path = expand(word, state);
	if (path === undefined) return undefined;
	if (isAbsolute(path)) return resolve(path);
	return state.cwd === undefined ? undefined : resolve(state.cwd, path);
}

/** Records a simple command's effect on the line: an assignment, an `export`, or a `cd`. */
export function follow(argv: readonly string[], state: LineState): void {
	const [head, ...args] = argv;
	if (head === undefined) return;
	const assignments =
		head === "export"
			? args
			: argv.every((w) => ASSIGNMENT.test(w))
				? argv
				: [];
	for (const word of assignments) {
		const match = ASSIGNMENT.exec(word);
		// An append (`x+=y`) makes a value the line does not follow.
		if (match)
			state.vars.set(
				match[1] as string,
				match[2] === "" ? expand(match[3] as string, state) : undefined,
			);
	}
	if (head === "cd" || head === "pushd" || head === "popd") {
		const target = args.find((a) => !a.startsWith("-"));
		state.cwd =
			state.followsCd && head === "cd" && target !== undefined
				? resolvePath(target, state)
				: undefined;
	}
}

/**
 * `expand` for a word that names a command or a script: a variable the line itself binds is
 * unknown there, because the line is followed assignment by assignment and bash may skip the one
 * that matters (`false && x=ls; $x sudo`, `(V=1); s${V}udo`), so the variable is empty. What the
 * line does not bind, such as `$HOME`, keeps its value.
 */
export function expandName(word: string, state: LineState): string | undefined {
	for (const match of word.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g))
		if (state.bound.has(match[1] as string)) return undefined;
	return expand(word, state);
}

/** How many times a line writes each name where it could bind it: as a bare word, or in `${name:=…}`. */
export function bindingCounts(command: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const match of command.matchAll(
		/(?<![$\w{])([A-Za-z_]\w*)(?!\w)|\$\{([A-Za-z_]\w*):?=/g,
	)) {
		const name = (match[1] ?? match[2]) as string;
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return counts;
}

/**
 * Forgets the value of each variable a command assigns when the line names it more than once. The
 * line is followed one assignment after another, but bash may bind a name by a loop, `read`,
 * `declare`, `eval`, a function or a branch the rule does not follow, so a name written twice may
 * hold either value (`x=ls; for x in sudo; do $x; done`); a name written once holds what it was
 * given or is unset.
 */
export function forgetRebound(
	words: readonly string[],
	state: LineState,
	counts: ReadonlyMap<string, number>,
): void {
	for (const word of words) {
		const name = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(word)?.[1];
		if (name !== undefined && (counts.get(name) ?? 0) > 1)
			state.vars.set(name, undefined);
	}
}

/** Whether `path` is `root` or under it, comparing the paths as written. */
export function under(path: string, root: string): boolean {
	const rel = relative(resolve(root), resolve(path));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The real path of `path`: its nearest existing ancestor's real path, joined with the rest. */
function realPath(path: string): string {
	let existing = path;
	while (!existsSync(existing) && dirname(existing) !== existing)
		existing = dirname(existing);
	try {
		return join(realpathSync(existing), relative(existing, path));
	} catch {
		return path;
	}
}

/** Whether a write to `path` stays inside a root, as written. */
function insideRoots(path: string, state: LineState): boolean {
	return state.roots.some((root) => under(path, root));
}

/**
 * Why an `rm` is held, or undefined when every operand resolves, through symlinks, under a scratch
 * root without being one; a glob is judged by its directory part.
 */
export function rmHeld(
	args: readonly string[],
	state: LineState,
): string | undefined {
	const operands: string[] = [];
	let options = true;
	for (const arg of args) {
		if (options && arg === "--") options = false;
		else if (options && arg.startsWith("-") && arg !== "-") continue;
		else operands.push(arg);
	}
	if (operands.length === 0) return "rm";
	const roots = state.roots.map(realPath);
	for (const operand of operands) {
		const glob = /[*?[]/.exec(operand);
		const pattern = glob ? operand : undefined;
		const word = glob
			? operand.slice(0, operand.lastIndexOf("/", glob.index) + 1) || "."
			: operand;
		// `.*` once matched `..`; a glob of hidden names is held.
		if (pattern && basename(pattern).startsWith(".")) return "rm";
		const path = resolvePath(word, state);
		if (path === undefined || path === "/") return "rm";
		const real = realPath(path);
		const inside = roots.some((root) =>
			pattern ? under(real, root) : under(real, root) && real !== root,
		);
		if (!inside) return "rm";
	}
	return undefined;
}

/**
 * Whether a write to the word stays inside a scratch root. A word the line cannot resolve is read
 * as written from the workspace, as before variables were followed.
 */
export function writable(word: string, state: LineState): boolean {
	if (word === "/dev/null") return true;
	return insideRoots(targetPath(word, state), state);
}

/** Where a write to the word lands: the word resolved from the line, else from the workspace, else as written. */
function targetPath(word: string, state: LineState): string {
	return (
		resolvePath(word, state) ??
		resolvePath(word, { ...state, vars: new Map(), cwd: state.workspace }) ??
		word
	);
}

/** Whether a write to the word reaches a device node, such as a disk, rather than `/dev/null`. */
export function deviceTarget(word: string, state: LineState): boolean {
	// A target the line cannot expand may be any device, so it is read as one.
	if (/[$`]/.test(word) && resolvePath(word, state) === undefined) return true;
	const path = targetPath(word, state);
	return path !== "/dev/null" && under(path, "/dev");
}
