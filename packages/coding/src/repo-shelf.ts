import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { AgentError, checkRepoName, scrubDiagnostic } from "pi-roundtable/kit";

/** What a clone would push to its default branch (repos-and-skills spec behavior 10). */
export interface ChangeReport {
	repo: string;
	/** The default branch the push goes to. */
	branch: string;
	/** HEAD's full SHA, the exact commit to push. */
	sha: string;
	/** `<short sha> <subject>`, newest first. */
	commits: string[];
	diffstat: string;
	/** The credential-free configured push destination shown on the approval card. */
	target: string;
}

/** One managed repository as repo_list shows it (behavior 3). */
export interface RepoSummary {
	repo: string;
	dir: string;
	branch: string;
	/** Commits ahead of and behind its upstream, as of the last fetch; absent without one. */
	upstream?: { ahead: number; behind: number };
	uncommitted: number;
	/** `<short sha> <subject> (<date>)`, absent in an empty repository. */
	lastCommit?: string;
	summary?: string;
	ciOnPush: boolean;
	/** Set when git could not describe it. */
	error?: string;
}

/** A clone's state, measured around a coding worker's run (behavior 8). */
export interface RepoState {
	branch: string;
	head: string;
	/** `git status --porcelain` lines. */
	uncommitted: string[];
}

export type CloneCommand = (repo: string, dir: string) => Promise<void>;

/** A coding worker's own checkout: a linked worktree on its own branch, cut from the clone's HEAD. */
export interface WorkerTree {
	repo: string;
	/** The worktree's real path, outside the shelf's list of managed repositories. */
	dir: string;
	/** The worker's branch, such as `worker/3`. */
	branch: string;
	/** The clone's full HEAD the branch was cut from. */
	base: string;
}

/** What bringing a worker's branch back into its clone did. */
export type Integration =
	/** The branch had no commits beyond the clone; the worktree and branch are gone. */
	| { status: "nothing" }
	/** Rebased onto the clone's branch and fast-forwarded it; the worktree and branch are gone. */
	| { status: "merged"; branch: string; commits: string[] }
	/** The rebase stopped on these files; it was aborted, and the branch and worktree are kept. */
	| { status: "conflict"; branch: string; dir: string; files: string[] }
	/** The clone or the worktree had uncommitted changes, or the clone moved; nothing was touched. */
	| {
			status: "refused";
			branch: string;
			dir: string;
			reason: string;
	  };

/** The folder under the shelf that holds worker worktrees; the shelf lists no repository there. */
export const WORKTREES_DIR = ".worktrees";

const GIT_TIMEOUT_MS = 60_000;
const MAX_STAT_FILES = 40;
const MAX_SUMMARY_CHARS = 120;

async function run(
	command: string[],
	cwd?: string,
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

/** Clones with gh, which authenticates with the host's GH_TOKEN; a failure's stderr is cut at `diagnosticChars`. */
const ghCloneWith =
	(diagnosticChars?: number): CloneCommand =>
	async (repo, dir) => {
		checkRepoName(repo);
		if (repo.startsWith("-"))
			throw new AgentError("Repository owner cannot start with a dash.");
		const { err, code } = await run([
			"gh",
			"repo",
			"clone",
			repo,
			dir,
			"--",
			"--quiet",
		]);
		if (code !== 0)
			throw new AgentError(
				`Cloning ${repo} failed: ${scrubDiagnostic(err, diagnosticChars) || `exit ${code}`}`,
			);
	};
export const ghClone: CloneCommand = ghCloneWith();

const MAX_METADATA_BYTES = 65_536;

/** Metadata discovery never follows links or opens devices/FIFOs; each file is bounded. */
function metadataText(path: string): string | undefined {
	let fd: number | undefined;
	try {
		if (!lstatSync(path).isFile()) return undefined;
		fd = openSync(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		if (!fstatSync(fd).isFile()) return undefined;
		const bytes = Buffer.alloc(MAX_METADATA_BYTES);
		const count = readSync(fd, bytes, 0, bytes.length, 0);
		return bytes.subarray(0, count).toString("utf8");
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** The first prose line of a README or AGENTS.md: no frontmatter, heading, badge, or markup. */
function summaryOf(dir: string): string | undefined {
	for (const name of ["README.md", "AGENTS.md"]) {
		const file = join(dir, name);
		const content = metadataText(file);
		if (!content) continue;
		const text = content.replace(/^---\n[\s\S]*?\n---\n/, "");
		const line = text
			.split("\n")
			.map((l) => l.trim())
			.find((l) => /\p{L}/u.test(l) && !/^([#!<>|`[\-*=]|\d+\.)/.test(l));
		if (line)
			return line.length > MAX_SUMMARY_CHARS
				? `${line.slice(0, MAX_SUMMARY_CHARS - 1)}…`
				: line;
	}
	return undefined;
}

function ciOnPush(dir: string): boolean {
	const workflows = join(dir, ".github", "workflows");
	try {
		if (
			!lstatSync(join(dir, ".github")).isDirectory() ||
			!lstatSync(workflows).isDirectory()
		)
			return false;
		return readdirSync(workflows)
			.filter((name) => /\.ya?ml$/.test(name))
			.some((name) =>
				/^\s*(on:\s*\[?[^\n]*\bpush\b|push\s*:)/m.test(
					metadataText(join(workflows, name)) ?? "",
				),
			);
	} catch {
		return false;
	}
}

/** The managed repositories under one folder, read and pushed through git. */
export class RepoShelf {
	readonly dir: string;
	readonly #clone: CloneCommand;
	readonly #reports = new Map<string, ChangeReport>();
	readonly #adding = new Set<string>();

	readonly #diagnosticChars: number | undefined;

	constructor(
		dir: string,
		clone?: CloneCommand,
		options: { diagnosticChars?: number | undefined } = {},
	) {
		this.dir = resolve(dir);
		this.#diagnosticChars = options.diagnosticChars;
		this.#clone = clone ?? ghCloneWith(options.diagnosticChars);
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
	async addWorktree(repo: string, id: number): Promise<WorkerTree> {
		const clone = this.dirOf(repo);
		const base = await this.#git(clone, "rev-parse", "HEAD");
		const parent = join(this.dir, WORKTREES_DIR, repo);
		mkdirSync(parent, { recursive: true });
		const rel = relative(realpathSync(this.dir), realpathSync(parent));
		if (rel.startsWith("..") || isAbsolute(rel))
			throw new AgentError("The worktree folder escapes the shelf.");
		for (let attempt = 1; ; attempt++) {
			const name = attempt === 1 ? `${id}` : `${id}-${attempt}`;
			const branch = `worker/${name}`;
			const dir = join(parent, name);
			const taken =
				existsSync(dir) ||
				(
					await run([
						"git",
						"-C",
						clone,
						"rev-parse",
						"--verify",
						"--quiet",
						`refs/heads/${branch}`,
					])
				).code === 0;
			if (taken) continue;
			await this.#git(
				clone,
				"worktree",
				"add",
				"--quiet",
				"-b",
				branch,
				dir,
				base,
			);
			return { repo, dir: realpathSync(dir), branch, base };
		}
	}

	/**
	 * Rebases the worker's branch onto the clone's current HEAD inside its worktree and
	 * fast-forwards the clone, then removes the worktree and branch. The clone is never left
	 * mid-rebase: a conflict aborts the rebase in the worktree and keeps both. A clone or worktree
	 * with uncommitted changes is not touched. The caller serializes integrations of one clone.
	 */
	async integrate(tree: WorkerTree): Promise<Integration> {
		const clone = this.dirOf(tree.repo);
		const kept = { branch: tree.branch, dir: tree.dir };
		const dirty = await this.#git(clone, "status", "--porcelain");
		if (dirty)
			return {
				status: "refused",
				...kept,
				reason: `the clone has uncommitted changes, so it was left as it is:\n${dirty}`,
			};
		const head = await this.#git(clone, "rev-parse", "HEAD");
		const ahead = Number(
			await this.#git(clone, "rev-list", "--count", `${head}..${tree.branch}`),
		);
		if (ahead === 0) {
			await this.removeWorktree(tree);
			return { status: "nothing" };
		}
		const treeDir = this.#treeDir(tree);
		const treeDirty = await this.#git(treeDir, "status", "--porcelain");
		if (treeDirty)
			return {
				status: "refused",
				...kept,
				reason: `the worker left uncommitted changes in its worktree:\n${treeDirty}`,
			};
		const rebase = await run(["git", "-C", treeDir, "rebase", "--quiet", head]);
		if (rebase.code !== 0) {
			const conflicted = await run([
				"git",
				"-C",
				treeDir,
				"diff",
				"--name-only",
				"--diff-filter=U",
			]);
			await run(["git", "-C", treeDir, "rebase", "--abort"]);
			return {
				status: "conflict",
				...kept,
				files: conflicted.out ? conflicted.out.split("\n") : [],
			};
		}
		const merge = await run([
			"git",
			"-C",
			clone,
			"merge",
			"--ff-only",
			"--quiet",
			tree.branch,
		]);
		if (merge.code !== 0)
			return {
				status: "refused",
				...kept,
				reason: `the clone could not fast-forward to the branch: ${scrubDiagnostic(merge.err, this.#diagnosticChars) || `exit ${merge.code}`}`,
			};
		const log = await this.#git(
			clone,
			"log",
			"--format=%h %s",
			"--abbrev=12",
			`${head}..HEAD`,
		);
		await this.removeWorktree(tree);
		return {
			status: "merged",
			branch: tree.branch,
			commits: log ? log.split("\n") : [],
		};
	}

	/** A worker worktree's state, as `state` reads a clone's. */
	async treeState(tree: WorkerTree): Promise<RepoState> {
		const dir = this.#treeDir(tree);
		const status = await this.#git(dir, "status", "--porcelain");
		return {
			branch: await this.#git(dir, "rev-parse", "--abbrev-ref", "HEAD"),
			head: await this.#git(dir, "rev-parse", "--short=12", "HEAD"),
			uncommitted: status ? status.split("\n") : [],
		};
	}

	/** `<short sha> <subject>` of each commit on the worker's branch after its base, newest first. */
	async treeCommits(tree: WorkerTree): Promise<string[]> {
		const log = await this.#git(
			this.#treeDir(tree),
			"log",
			"--format=%h %s",
			"--abbrev=12",
			`${tree.base}..HEAD`,
		);
		return log ? log.split("\n") : [];
	}

	/** Removes a worker's worktree and its branch; what is already gone is skipped. */
	async removeWorktree(tree: WorkerTree): Promise<void> {
		const clone = this.dirOf(tree.repo);
		this.#treeDir(tree, false);
		await run(["git", "-C", clone, "worktree", "remove", "--force", tree.dir]);
		if (existsSync(tree.dir))
			rmSync(tree.dir, { recursive: true, force: true });
		await run(["git", "-C", clone, "worktree", "prune"]);
		await run(["git", "-C", clone, "branch", "-D", "--quiet", tree.branch]);
	}

	/** A worktree path, refused unless it lies in this repository's worktree folder. */
	#treeDir(tree: WorkerTree, mustExist = true): string {
		const parent = resolve(this.dir, WORKTREES_DIR, tree.repo);
		const path = mustExist ? realpathSync(tree.dir) : resolve(tree.dir);
		const root = existsSync(parent) ? realpathSync(parent) : parent;
		const rel = relative(root, path);
		if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.includes("/"))
			throw new AgentError(
				"The worktree lies outside the shelf's worktree folder.",
			);
		return path;
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
			const last = await run([
				"git",
				"-C",
				dir,
				"log",
				"-1",
				"--format=%h %s (%cs)",
				"--abbrev=12",
			]);
			const counts = await run([
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
			run([
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

	async #git(dir: string, ...args: string[]): Promise<string> {
		const { out, err, code } = await run(["git", "-C", dir, ...args]);
		if (code !== 0)
			throw new AgentError(
				`git ${args[0]} failed in ${dir}: ${scrubDiagnostic(err, this.#diagnosticChars) || `exit ${code}`}`,
			);
		return out;
	}
}

/** Owners starting with a dot are the shelf's own folders, such as its worktrees. */
function refuseHidden(repo: string): void {
	if (repo.startsWith("."))
		throw new AgentError(
			`"${repo}" is not a repository: owners starting with a dot are reserved for the shelf.`,
		);
}

/** The report as posted for the owner. */
export function reportPost(report: ChangeReport, direct = false): string {
	return [
		`**Change report**: \`${report.repo}\`, commit \`${report.sha}\`, default branch \`${report.branch}\`.`,
		`**Push destination**: \`${report.target}\``,
		`**Commits (${report.commits.length})**`,
		...report.commits.map((c) => `- \`${c.slice(0, 12)}\`${c.slice(12)}`),
		"**Changed files**",
		`\`\`\`\n${report.diffstat}\n\`\`\``,
		direct
			? "This repository is explicitly owner-owned; repo_push does not need an approval card."
			: `After approval: repo_push ${report.repo} ${report.sha}`,
	].join("\n");
}
