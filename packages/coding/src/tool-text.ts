import type { RepoToolName } from "./coding-options.ts";

/** The shipped wording of every repository tool; frozen at every depth. */
export type RepoToolTexts = Readonly<
	Record<
		RepoToolName,
		Readonly<{
			description: string;
			parameters: Readonly<Record<string, string>>;
		}>
	>
>;

const REPO = "A managed repository, owner/repo.";

/** Freezes the value and every object inside it. */
function deepFreeze<T extends object>(value: T): T {
	for (const child of Object.values(value))
		if (child && typeof child === "object") deepFreeze(child);
	return Object.freeze(value);
}

/**
 * The wording of each repository tool as the package ships it: the description, and the argument
 * descriptions by argument name (an argument absent here has none). A host words only what must
 * differ through `toolText`, such as
 * `{ repo_task: { description: `${DEFAULT_TOOL_TEXT.repo_task.description} Extra.` } }`, and
 * compares against this to see what a new package version changed.
 */
export const DEFAULT_TOOL_TEXT: RepoToolTexts = deepFreeze({
	repo_list: {
		description:
			"List managed clones, branch, upstream counts, dirty files, last commit, summary, CI hints and linked skills. Fetch first only when requested.",
		parameters: {},
	},
	repo_add: {
		description:
			"Clone owner/repo into the shelf using the host's Git login (GitHub CLI by default).",
		parameters: { repo: REPO },
	},
	repo_change_report: {
		description:
			"Fetch and report commits and changed files for the default branch. Requires a clean, ahead-only clone. Review checks before requesting this report.",
		parameters: { repo: REPO },
	},
	repo_push: {
		description:
			"Push the SHA from the latest change report to its default branch, without force. Held for owner approval unless the trusted host policy explicitly marks the clone owner-owned.",
		parameters: { repo: REPO },
	},
	repo_task: {
		description:
			"Start a background Pi coding worker on a clone. Each worker has its own worktree and branch, so several may work on one repository; when it finishes, its commits are rebased onto the clone and fast-forwarded, and a conflict keeps the branch and is reported. When every worker slot is taken the task waits in a queue. The worker reads repository instructions, edits, checks and commits; shipping uses a separate report and approval. Report returns to this channel.",
		parameters: { repo: REPO },
	},
	repo_task_list: {
		description:
			"List running and queued coding tasks with id, repository, who started each, when, and the first line of its task. An agent sees the tasks it started; an owner sees all.",
		parameters: { repo: "Only this repository, owner/repo." },
	},
	repo_task_cancel: {
		description:
			"Cancel a coding task by id. A queued task is dropped and never runs; a running worker is stopped, and its commits stay on its branch and worktree, not merged into the clone. An agent may cancel the tasks it started; an owner may cancel any.",
		parameters: {
			repo: REPO,
			id: "The task's number, as #N.",
			reason: "Why, for its report.",
		},
	},
});
