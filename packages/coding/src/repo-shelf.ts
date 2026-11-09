import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	renameSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { AgentError, checkRepoName } from "pi-roundtable/kit";
import { GitRunner, ghCloneWith } from "./git-run.ts";
import { ciOnPush, summaryOf } from "./repo-metadata.ts";
import type {
	ChangeReport,
	CloneCommand,
	GithubToken,
	Integration,
	RepoState,
	RepoSummary,
	WorkerTree,
} from "./repo-types.ts";
import { WorkerTrees } from "./worktrees.ts";

export { reportPost } from "./repo-report.ts";
export type {
	ChangeReport,
	CloneCommand,
	GithubToken,
	Integration,
	RepoState,
	RepoSummary,
	WorkerTree,
} from "./repo-types.ts";
export { WORKTREES_DIR } from "./repo-types.ts";

const MAX_STAT_FILES = 40;

/** Clones with gh and the host's token; see `ghCloneWith`. */
export const ghClone: CloneCommand = ghCloneWith();

/** The managed repositories under one folder, read and pushed through git. */
export class RepoShelf {
	readonly dir: string;
	readonly #clone: CloneCommand;
	readonly #reports = new Map<string, ChangeReport>();
	readonly #adding = new Set<string>();
	readonly #runner: GitRunner;
	readonly #trees: WorkerTrees;

	constructor(
		dir: string,
		clone?: CloneCommand,
		options: {
			diagnosticChars?: number | undefined;
			githubToken?: GithubToken | undefined;
		} = {},
	) {
		this.dir = resolve(dir);
		const { githubToken = process.env.GH_TOKEN } = options;
		const token =
			typeof githubToken === "function" ? githubToken : () => githubToken;
		this.#runner = new GitRunner(token, options.diagnosticChars);
		this.#trees = new WorkerTrees(
			this.dir,
			(repo) => this.dirOf(repo),
			this.#runner,
		);
		this.#clone = clone ?? ghCloneWith(options.diagnosticChars, token);
	}

	/** Adopt an existing standalone clone at startup; an existing destination is never replaced. */
	adopt(from: string, repo: string): boolean {
		checkRepoName(repo);
		const to = join(this.dir, repo);
		if (
			!existsSync(join(from, ".git")) ||
			lstatSync(to, { throwIfNoEntry: false })
		)
			return false;
		if (
			!lstatSync(from).isDirectory() ||
			!lstatSync(join(from, ".git")).isDirectory()
		)
			throw new AgentError("Only standalone local clones can be adopted.");
		mkdirSync(dirname(to), { recursive: true });
		const rel = relative(realpathSync(this.dir), realpathSync(dirname(to)));
		if (rel.startsWith("..") || isAbsolute(rel))
			throw new AgentError("Repository owner directory escapes the shelf.");
		renameSync(from, to);
		this.dirOf(repo);
		return true;
	}

	/** Every clone as `<owner>/<repo>`, sorted. */
	repos(): string[] {
		if (!existsSync(this.dir)) return [];
		// pi-lens-ignore: no-sort-without-comparator — the names are strings, and code-unit order gives the same list on every machine
		return readdirSync(this.dir, { withFileTypes: true })
			.filter((owner) => owner.isDirectory() && !owner.name.startsWith("."))
			.flatMap((owner) =>
				readdirSync(join(this.dir, owner.name), {
					withFileTypes: true,
				}).flatMap((repo) =>
					repo.isDirectory() &&
					existsSync(join(this.dir, owner.name, repo.name, ".git"))
						? [`${owner.name}/${repo.name}`]
						: [],
				),
			)
			.sort();
	}

	/** A managed repository's folder, or an error naming the managed ones. */
	dirOf(repo: string): string {
		checkRepoName(repo);
		refuseHidden(repo);
		const dir = join(this.dir, repo);
		if (!existsSync(join(dir, ".git")))
			throw new AgentError(
				`${repo} is not a managed repository. Managed: ${this.repos().join(", ") || "none"}; add one with repo_add.`,
			);
		const root = realpathSync(this.dir);
		const path = realpathSync(dir);
		const rel = relative(root, path);
		if (rel.startsWith("..") || isAbsolute(rel))
			throw new AgentError("Repository path escapes the shelf.");
		if (!lstatSync(join(dir, ".git")).isDirectory())
			throw new AgentError(
				"Managed repositories must have a local Git directory, not a linked worktree.",
			);
		const gitRel = relative(path, realpathSync(join(dir, ".git")));
		if (gitRel.startsWith("..") || isAbsolute(gitRel))
			throw new AgentError("Repository Git directory escapes the clone.");
		return path;
	}

	async list(fetch: boolean): Promise<RepoSummary[]> {
		return Promise.all(this.repos().map((repo) => this.#summary(repo, fetch)));
	}

	/** Clones a repository into the shelf (behavior 2). */
	async add(repo: string): Promise<string> {
		checkRepoName(repo);
		refuseHidden(repo);
		const dir = join(this.dir, repo);
		if (existsSync(dir) || this.#adding.has(repo))
			throw new AgentError(`${repo} is already present or being cloned.`);
		mkdirSync(this.dir, { recursive: true });
		mkdirSync(dirname(dir), { recursive: true });
		const rel = relative(realpathSync(this.dir), realpathSync(dirname(dir)));
		if (rel.startsWith("..") || isAbsolute(rel))
			throw new AgentError("Repository owner directory escapes the shelf.");
		this.#adding.add(repo);
		try {
			await this.#clone(repo, dir);
			return this.dirOf(repo);
		} finally {
			this.#adding.delete(repo);
		}
	}

	/**
	 * Fetches and describes what HEAD adds to the default branch. Refuses a dirty tree, a HEAD
	 * with nothing to push, and a HEAD missing commits of the default branch.
	 */
	async report(repo: string): Promise<ChangeReport> {
		const dir = this.dirOf(repo);
		this.#reports.delete(repo);
		const target = await this.#pushTarget(dir);
		await this.#git(dir, "fetch", "--quiet", "origin");
		const branch = await this.#defaultBranch(dir);
		const base = `origin/${branch}`;
		const dirty = await this.#git(dir, "status", "--porcelain");
		if (dirty)
			throw new AgentError(
				`${repo} has uncommitted changes; commit or discard them first:\n${dirty}`,
			);
		const behind = Number(
			await this.#git(dir, "rev-list", "--count", `HEAD..${base}`),
		);
		if (behind > 0)
			throw new AgentError(
				`${base} has ${behind} commits HEAD lacks; run \`git -C ${dir} rebase ${base}\`, check again, and report again.`,
			);
		const log = await this.#git(
			dir,
			"log",
			"--format=%h %s",
			"--abbrev=12",
			`${base}..HEAD`,
		);
		if (!log)
			throw new AgentError(`HEAD adds nothing to ${base}; commit first.`);
		const stat = (
			await this.#git(dir, "diff", "--stat=100", `${base}...HEAD`)
		).split("\n");
		const files = stat.slice(0, -1);
		const diffstat =
			files.length > MAX_STAT_FILES
				? [
						...files.slice(0, MAX_STAT_FILES),
						` … ${files.length - MAX_STAT_FILES} more files`,
						stat.at(-1) ?? "",
					].join("\n")
				: stat.join("\n");
		const report = {
			repo,
			branch,
			sha: await this.#git(dir, "rev-parse", "HEAD"),
			commits: log.split("\n"),
			diffstat,
			target,
		};
		this.#reports.set(repo, report);
		return report;
	}

	/** A synchronous hold description from the latest report, safe to show on an owner card. */
	pushDescription(repo: string, sha: string): string {
		const report = this.#reports.get(repo);
		if (!report || !/^[0-9a-f]{7,40}$/.test(sha) || !report.sha.startsWith(sha))
			return `Push ${repo} commit ${sha}; request a fresh change report first`;
		return `Push ${repo} commit ${sha} to ${report.target}, branch ${report.branch}`;
	}

	/** Pushes exactly HEAD, named by its sha, to the reported destination and default branch. */
	async push(repo: string, sha: string): Promise<string> {
		const dir = this.dirOf(repo);
		const head = await this.#git(dir, "rev-parse", "HEAD");
		const report = this.#reports.get(repo);
		if (
			!/^[0-9a-f]{7,40}$/.test(sha) ||
			!report?.sha.startsWith(sha) ||
			head !== report.sha
		)
			throw new AgentError(
				`${sha} is not HEAD of ${repo} (HEAD is ${head.slice(0, 12)}); report again with repo_change_report.`,
			);
		if ((await this.#pushTarget(dir)) !== report.target)
			throw new AgentError(
				"The push destination changed; request a new report.",
			);
		const branch = await this.#defaultBranch(dir);
		if (branch !== report.branch)
			throw new AgentError("The default branch changed; request a new report.");
		if (await this.#git(dir, "status", "--porcelain"))
			throw new AgentError("The clone is dirty; request a new report.");
		await this.#git(
			dir,
			"push",
			"--quiet",
			report.target,
			`${head}:refs/heads/${branch}`,
		);
		this.#reports.delete(repo);
		return branch;
	}

	async state(repo: string): Promise<RepoState> {
		const dir = this.dirOf(repo);
		const status = await this.#git(dir, "status", "--porcelain");
		return {
			branch: await this.#git(dir, "rev-parse", "--abbrev-ref", "HEAD"),
			head: await this.#git(dir, "rev-parse", "--short=12", "HEAD"),
			uncommitted: status ? status.split("\n") : [],
		};
	}

	/** `<short sha> <subject>` of each commit after `from`, newest first. */
	async commitsSince(repo: string, from: string): Promise<string[]> {
		const log = await this.#git(
			this.dirOf(repo),
			"log",
			"--format=%h %s",
			"--abbrev=12",
			`${from}..HEAD`,
		);
		return log ? log.split("\n") : [];
	}

	/**
	 * Cuts a worktree for coding job `id` from the clone's HEAD, on a fresh branch `worker/<id>`
	 * (with a suffix when an earlier run kept one of that name), under `<shelf>/.worktrees/`.
	 */
	addWorktree(repo: string, id: number): Promise<WorkerTree> {
		return this.#trees.add(repo, id);
	}

	/**
	 * Rebases the worker's branch onto the clone's current HEAD inside its worktree and
	 * fast-forwards the clone, then removes the worktree and branch. The clone is never left
	 * mid-rebase: a conflict aborts the rebase in the worktree and keeps both. A clone or worktree
	 * with uncommitted changes is not touched. The caller serializes integrations of one clone.
	 */
	integrate(tree: WorkerTree): Promise<Integration> {
		return this.#trees.integrate(tree);
	}

	/** A worker worktree's state, as `state` reads a clone's. */
	treeState(tree: WorkerTree): Promise<RepoState> {
		return this.#trees.state(tree);
	}

	/** `<short sha> <subject>` of each commit on the worker's branch after its base, newest first. */
	treeCommits(tree: WorkerTree): Promise<string[]> {
		return this.#trees.commits(tree);
	}

	/** Removes a worker's worktree and its branch; what is already gone is skipped. */
	removeWorktree(tree: WorkerTree): Promise<void> {
		return this.#trees.remove(tree);
	}

	async #summary(repo: string, fetch: boolean): Promise<RepoSummary> {
		const dir = this.dirOf(repo);
		const summary = summaryOf(dir);
		const base = {
			repo,
			dir,
			ciOnPush: ciOnPush(dir),
			...(summary ? { summary } : {}),
		};
		try {
			if (fetch) await this.#git(dir, "fetch", "--quiet", "origin");
			const branch = await this.#git(dir, "rev-parse", "--abbrev-ref", "HEAD");
			const status = await this.#git(dir, "status", "--porcelain");
			const last = await this.#run([
				"git",
				"-C",
				dir,
				"log",
				"-1",
				"--format=%h %s (%cs)",
				"--abbrev=12",
			]);
			const counts = await this.#run([
				"git",
				"-C",
				dir,
				"rev-list",
				"--left-right",
				"--count",
				"HEAD...@{upstream}",
			]);
			const [ahead, behind] = counts.out.split(/\s+/).map(Number);
			return {
				...base,
				branch,
				uncommitted: status ? status.split("\n").length : 0,
				...(last.code === 0 && last.out ? { lastCommit: last.out } : {}),
				...(counts.code === 0
					? { upstream: { ahead: ahead ?? 0, behind: behind ?? 0 } }
					: {}),
			};
		} catch (error) {
			return {
				...base,
				branch: "?",
				uncommitted: 0,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async #pushTarget(dir: string): Promise<string> {
		const targets = (
			await this.#git(dir, "remote", "get-url", "--push", "--all", "origin")
		).split("\n");
		const target = targets[0];
		if (!target || targets.length !== 1 || target.startsWith("-"))
			throw new AgentError("origin must have exactly one push destination.");
		if (/^https?:\/\//i.test(target)) {
			let url: URL;
			try {
				url = new URL(target);
			} catch {
				throw new AgentError("origin has an invalid remote URL.");
			}
			if (url.username || url.password || url.search || url.hash)
				throw new AgentError(
					"Use the host's credential helper, not a credential-bearing remote URL.",
				);
		}
		return target;
	}

	/** Refresh origin/HEAD from the remote, including default-branch changes during approval. */
	async #defaultBranch(dir: string): Promise<string> {
		await this.#git(dir, "remote", "set-head", "origin", "--auto");
		const read = () =>
			this.#run([
				"git",
				"-C",
				dir,
				"symbolic-ref",
				"--short",
				"refs/remotes/origin/HEAD",
			]);
		const head = await read();
		if (head.code !== 0 || !head.out.startsWith("origin/"))
			throw new AgentError(`${dir} has no default branch on origin.`);
		return head.out.slice("origin/".length);
	}

	#run(
		command: string[],
		cwd?: string,
	): Promise<{ out: string; err: string; code: number }> {
		return this.#runner.run(command, cwd);
	}

	#git(dir: string, ...args: string[]): Promise<string> {
		return this.#runner.git(dir, ...args);
	}
}

/** Owners starting with a dot are the shelf's own folders, such as its worktrees. */
function refuseHidden(repo: string): void {
	if (repo.startsWith("."))
		throw new AgentError(
			`"${repo}" is not a repository: owners starting with a dot are reserved for the shelf.`,
		);
}
