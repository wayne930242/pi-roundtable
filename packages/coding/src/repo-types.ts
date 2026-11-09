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

/**
 * The GitHub token git and gh calls get as GH_TOKEN, or a function read at each call; undefined
 * leaves them to gh's own login.
 */
export type GithubToken = string | undefined | (() => string | undefined);

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
