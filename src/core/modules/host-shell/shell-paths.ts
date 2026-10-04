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
		followsCd: !/(^|[^$])\(|\|\|/.test(command),
	};
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

/**
 * The word with the line's variables substituted and `~` expanded, or undefined when it holds a
 * command substitution, an unknown variable or `~user`.
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
		if (match)
			state.vars.set(match[1] as string, expand(match[2] as string, state));
	}
	if (head === "cd" || head === "pushd" || head === "popd") {
		const target = args.find((a) => !a.startsWith("-"));
		state.cwd =
			state.followsCd && head === "cd" && target !== undefined
				? resolvePath(target, state)
				: undefined;
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
export function insideRoots(path: string, state: LineState): boolean {
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
