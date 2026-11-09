import {
	AgentError,
	checkRepoName,
	childEnv,
	scrubDiagnostic,
} from "pi-roundtable/kit";
import type { CloneCommand } from "./repo-types.ts";

const GIT_TIMEOUT_MS = 60_000;

/**
 * Host variables git and gh need besides the shell's: their config files and homes, the identity a
 * rebase commits as, ssh agent and ssh command, and gh's host; never a token, which comes from
 * `githubToken`.
 */
const GIT_ENV_NAMES = [
	"XDG_CONFIG_HOME",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"GIT_CONFIG_NOSYSTEM",
	"GIT_AUTHOR_NAME",
	"GIT_AUTHOR_EMAIL",
	"GIT_COMMITTER_NAME",
	"GIT_COMMITTER_EMAIL",
	"GH_CONFIG_DIR",
	"GH_HOST",
	"SSH_AUTH_SOCK",
	"GIT_SSH",
	"GIT_SSH_COMMAND",
];

/** The environment of a git or gh call: the shell's whitelist, git's own names, and the token as GH_TOKEN. */
function gitEnv(token: string | undefined): Record<string, string> {
	return childEnv(process.env, {
		pass: GIT_ENV_NAMES,
		...(token ? { set: { GH_TOKEN: token } } : {}),
	});
}

async function run(
	command: string[],
	cwd: string | undefined,
	env: Record<string, string>,
): Promise<{ out: string; err: string; code: number }> {
	const safeCommand =
		command[0] === "git"
			? [
					"git",
					"-c",
					"core.fsmonitor=false",
					"-c",
					"core.hooksPath=/dev/null",
					...command.slice(1),
				]
			: command;
	const child = Bun.spawn(safeCommand, {
		...(cwd ? { cwd } : {}),
		env,
		stdout: "pipe",
		stderr: "pipe",
		timeout: GIT_TIMEOUT_MS,
	});
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { out: out.trimEnd(), err: err.trim(), code };
}

/**
 * Clones with gh, which authenticates with `token` as GH_TOKEN (default the host's GH_TOKEN, read
 * at each clone) or its own login; a failure's stderr is cut at `diagnosticChars`.
 */
export const ghCloneWith =
	(diagnosticChars?: number, token?: () => string | undefined): CloneCommand =>
	async (repo, dir) => {
		checkRepoName(repo);
		if (repo.startsWith("-"))
			throw new AgentError("Repository owner cannot start with a dash.");
		const { err, code } = await run(
			["gh", "repo", "clone", repo, dir, "--", "--quiet"],
			undefined,
			gitEnv(token ? token() : process.env.GH_TOKEN),
		);
		if (code !== 0)
			throw new AgentError(
				`Cloning ${repo} failed: ${scrubDiagnostic(err, diagnosticChars) || `exit ${code}`}`,
			);
	};
export const ghClone: CloneCommand = ghCloneWith();

/** Git and gh calls that carry the shelf's token and no other host secret. */
export class GitRunner {
	readonly #token: () => string | undefined;
	readonly diagnosticChars: number | undefined;

	constructor(token: () => string | undefined, diagnosticChars?: number) {
		this.#token = token;
		this.diagnosticChars = diagnosticChars;
	}

	/** A git or gh call with the shelf's token and no other host secret. */
	run(
		command: string[],
		cwd?: string,
	): Promise<{ out: string; err: string; code: number }> {
		return run(command, cwd, gitEnv(this.#token()));
	}

	/** `git -C dir <args>`, its stdout; a failure throws with the scrubbed stderr. */
	async git(dir: string, ...args: string[]): Promise<string> {
		const { out, err, code } = await this.run(["git", "-C", dir, ...args]);
		if (code !== 0)
			throw new AgentError(
				`git ${args[0]} failed in ${dir}: ${scrubDiagnostic(err, this.diagnosticChars) || `exit ${code}`}`,
			);
		return out;
	}
}
