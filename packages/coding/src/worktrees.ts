import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { AgentError, scrubDiagnostic } from "pi-roundtable/kit";
import type { GitRunner } from "./git-run.ts";
import {
	type Integration,
	type RepoState,
	WORKTREES_DIR,
	type WorkerTree,
} from "./repo-types.ts";

/** The worker worktrees under one shelf: cut from a clone, integrated back, removed. */
export class WorkerTrees {
	readonly #shelfDir: string;
	readonly #dirOf: (repo: string) => string;
	readonly #runner: GitRunner;

	constructor(
		shelfDir: string,
		dirOf: (repo: string) => string,
		runner: GitRunner,
	) {
		this.#shelfDir = shelfDir;
		this.#dirOf = dirOf;
		this.#runner = runner;
	}

	/**
	 * Cuts a worktree for coding job `id` from the clone's HEAD, on a fresh branch `worker/<id>`
	 * (with a suffix when an earlier run kept one of that name), under `<shelf>/.worktrees/`.
	 */
	async add(repo: string, id: number): Promise<WorkerTree> {
		const clone = this.#dirOf(repo);
		const base = await this.#runner.git(clone, "rev-parse", "HEAD");
		const parent = join(this.#shelfDir, WORKTREES_DIR, repo);
		mkdirSync(parent, { recursive: true });
		const rel = relative(realpathSync(this.#shelfDir), realpathSync(parent));
		if (rel.startsWith("..") || isAbsolute(rel))
			throw new AgentError("The worktree folder escapes the shelf.");
		for (let attempt = 1; ; attempt++) {
			const name = attempt === 1 ? `${id}` : `${id}-${attempt}`;
			const branch = `worker/${name}`;
			const dir = join(parent, name);
			const taken =
				existsSync(dir) ||
				(
					await this.#runner.run([
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
			await this.#runner.git(
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
		const clone = this.#dirOf(tree.repo);
		const kept = { branch: tree.branch, dir: tree.dir };
		const dirty = await this.#runner.git(clone, "status", "--porcelain");
		if (dirty)
			return {
				status: "refused",
				...kept,
				reason: `the clone has uncommitted changes, so it was left as it is:\n${dirty}`,
			};
		const head = await this.#runner.git(clone, "rev-parse", "HEAD");
		const ahead = Number(
			await this.#runner.git(
				clone,
				"rev-list",
				"--count",
				`${head}..${tree.branch}`,
			),
		);
		if (ahead === 0) {
			await this.remove(tree);
			return { status: "nothing" };
		}
		const treeDir = this.#treeDir(tree);
		const treeDirty = await this.#runner.git(treeDir, "status", "--porcelain");
		if (treeDirty)
			return {
				status: "refused",
				...kept,
				reason: `the worker left uncommitted changes in its worktree:\n${treeDirty}`,
			};
		const rebase = await this.#runner.run([
			"git",
			"-C",
			treeDir,
			"rebase",
			"--quiet",
			head,
		]);
		if (rebase.code !== 0) {
			const conflicted = await this.#runner.run([
				"git",
				"-C",
				treeDir,
				"diff",
				"--name-only",
				"--diff-filter=U",
			]);
			await this.#runner.run(["git", "-C", treeDir, "rebase", "--abort"]);
			return {
				status: "conflict",
				...kept,
				files: conflicted.out ? conflicted.out.split("\n") : [],
			};
		}
		const merge = await this.#runner.run([
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
				reason: `the clone could not fast-forward to the branch: ${scrubDiagnostic(merge.err, this.#runner.diagnosticChars) || `exit ${merge.code}`}`,
			};
		const log = await this.#runner.git(
			clone,
			"log",
			"--format=%h %s",
			"--abbrev=12",
			`${head}..HEAD`,
		);
		await this.remove(tree);
		return {
			status: "merged",
			branch: tree.branch,
			commits: log ? log.split("\n") : [],
		};
	}

	/** A worker worktree's state, as `state` reads a clone's. */
	async state(tree: WorkerTree): Promise<RepoState> {
		const dir = this.#treeDir(tree);
		const status = await this.#runner.git(dir, "status", "--porcelain");
		return {
			branch: await this.#runner.git(dir, "rev-parse", "--abbrev-ref", "HEAD"),
			head: await this.#runner.git(dir, "rev-parse", "--short=12", "HEAD"),
			uncommitted: status ? status.split("\n") : [],
		};
	}

	/** `<short sha> <subject>` of each commit on the worker's branch after its base, newest first. */
	async commits(tree: WorkerTree): Promise<string[]> {
		const log = await this.#runner.git(
			this.#treeDir(tree),
			"log",
			"--format=%h %s",
			"--abbrev=12",
			`${tree.base}..HEAD`,
		);
		return log ? log.split("\n") : [];
	}

	/** Removes a worker's worktree and its branch; what is already gone is skipped. */
	async remove(tree: WorkerTree): Promise<void> {
		const clone = this.#dirOf(tree.repo);
		this.#treeDir(tree, false);
		await this.#runner.run([
			"git",
			"-C",
			clone,
			"worktree",
			"remove",
			"--force",
			tree.dir,
		]);
		if (existsSync(tree.dir))
			rmSync(tree.dir, { recursive: true, force: true });
		await this.#runner.run(["git", "-C", clone, "worktree", "prune"]);
		await this.#runner.run([
			"git",
			"-C",
			clone,
			"branch",
			"-D",
			"--quiet",
			tree.branch,
		]);
	}

	/** A worktree path, refused unless it lies in this repository's worktree folder. */
	#treeDir(tree: WorkerTree, mustExist = true): string {
		const parent = resolve(this.#shelfDir, WORKTREES_DIR, tree.repo);
		const path = mustExist ? realpathSync(tree.dir) : resolve(tree.dir);
		const root = existsSync(parent) ? realpathSync(parent) : parent;
		const rel = relative(root, path);
		if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.includes("/"))
			throw new AgentError(
				"The worktree lies outside the shelf's worktree folder.",
			);
		return path;
	}
}
