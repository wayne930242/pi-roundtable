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
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { AgentError, checkRepoName } from "pi-roundtable/kit";

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

/** Clones with gh, which authenticates with the host's GH_TOKEN. */
export const ghClone: CloneCommand = async (repo, dir) => {
	checkRepoName(repo);
	if (repo.startsWith("-"))
		throw new AgentError("Repository owner cannot start with a dash.");
	const { code } = await run([
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
			`Cloning ${repo} failed (exit ${code}); check the host's Git login.`,
		);
};

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

	constructor(dir: string, clone: CloneCommand = ghClone) {
		this.dir = resolve(dir);
		this.#clone = clone;
	}

	/** Every clone as `<owner>/<repo>`, sorted. */
	repos(): string[] {
		if (!existsSync(this.dir)) return [];
		// pi-lens-ignore: no-sort-without-comparator — the names are strings, and code-unit order gives the same list on every machine
		return readdirSync(this.dir, { withFileTypes: true })
			.filter((owner) => owner.isDirectory())
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
		if (!report || report.sha !== sha)
			return `Push ${repo} commit ${sha}; request a fresh change report first`;
		return `Push ${repo} commit ${sha} to ${report.target}, branch ${report.branch}`;
	}

	/** Pushes exactly HEAD, named by its sha, to the reported destination and default branch. */
	async push(repo: string, sha: string): Promise<string> {
		const dir = this.dirOf(repo);
		const head = await this.#git(dir, "rev-parse", "HEAD");
		const report = this.#reports.get(repo);
		if (!report || report.sha !== sha || head !== sha)
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
		const { out, code } = await run(["git", "-C", dir, ...args]);
		if (code !== 0)
			throw new AgentError(
				`git ${args[0]} failed (exit ${code}); check the clone and the host's Git login.`,
			);
		return out;
	}
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
