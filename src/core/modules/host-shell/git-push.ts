import { execFileSync } from "node:child_process";
import { type LineState, resolvePath } from "./shell-paths.ts";

/** Which pushes run without the owner's approval; see `shellHoldRuleFor`. */
export interface PushPolicy {
	/** GitHub owners whose repositories take a plain push without a hold. */
	ownPushOwners?: readonly string[];
	/** `owner/repo` names that stay held although their owner is listed. */
	heldPushRepos?: readonly string[];
}

const GIT_TIMEOUT_MS = 3_000;

/** Push options that neither force, delete, nor push tags or more than the named refs. */
const PLAIN_FLAGS = new Set([
	"-u",
	"--set-upstream",
	"-q",
	"--quiet",
	"-v",
	"--verbose",
	"-n",
	"--dry-run",
	"--no-verify",
	"--verify",
	"--atomic",
	"--porcelain",
	"--progress",
	"--no-progress",
]);

/** `owner/repo` of a GitHub remote URL, https or ssh, or undefined. */
export function githubRepo(url: string): string | undefined {
	const match =
		/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i.exec(
			url.trim(),
		);
	return match ? `${match[1]}/${match[2]}`.toLowerCase() : undefined;
}

function git(dir: string, args: readonly string[]): string | undefined {
	try {
		return execFileSync("git", ["-C", dir, ...args], {
			encoding: "utf8",
			timeout: GIT_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return undefined;
	}
}

/**
 * Whether `git <global> push <args>` is a plain push to one of the owner's own GitHub repositories:
 * no force, deletion, tags or mirror, and a remote whose push URLs all belong to a listed owner.
 */
export function ownPush(
	globals: readonly string[],
	args: readonly string[],
	state: LineState,
	policy: PushPolicy,
): boolean {
	const owners = (policy.ownPushOwners ?? []).map((o) => o.toLowerCase());
	if (owners.length === 0) return false;
	let dir = state.cwd;
	for (let i = 0; i < globals.length; i++) {
		// `-c`, `--git-dir` and the like can point the push elsewhere.
		if (globals[i] !== "-C") return false;
		const next = globals[++i];
		if (next === undefined || dir === undefined) return false;
		dir = resolvePath(next, { ...state, cwd: dir });
	}
	if (dir === undefined) return false;
	const positional: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "-o" || arg === "--push-option") i++;
		else if (arg.startsWith("--push-option=")) continue;
		else if (arg.startsWith("-")) {
			if (!PLAIN_FLAGS.has(arg)) return false;
		} else positional.push(arg);
	}
	const [remote = "origin", ...refspecs] = positional;
	for (const refspec of refspecs) {
		if (refspec.startsWith("+") || refspec.startsWith(":")) return false;
		if (refspec.includes("refs/tags/")) return false;
		for (const ref of refspec.split(":"))
			if (
				ref &&
				git(dir, ["show-ref", "--verify", "--quiet", `refs/tags/${ref}`]) !==
					undefined
			)
				return false;
	}
	const urls = /[:/]/.test(remote)
		? [remote]
		: git(dir, ["remote", "get-url", "--push", "--all", remote])
				?.split("\n")
				.filter(Boolean);
	if (!urls || urls.length === 0) return false;
	const held = new Set(
		(policy.heldPushRepos ?? []).map((r) => r.toLowerCase()),
	);
	return urls.every((url) => {
		const repo = githubRepo(url);
		return (
			repo !== undefined &&
			owners.includes(repo.split("/")[0] as string) &&
			!held.has(repo)
		);
	});
}
