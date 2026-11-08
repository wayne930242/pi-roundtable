import type { CodingResult } from "./coding-desk.ts";
import type { Integration } from "./repo-shelf.ts";

/** What became of the worker's branch, for the report. */
export function integrationText(
	integration: Integration | undefined,
	branch: string | undefined,
): string | undefined {
	switch (integration?.status) {
		case "merged":
			return `Merged ${integration.branch}: rebased onto the clone's branch and fast-forwarded it.`;
		case "nothing":
			return `${branch ?? "The worker's branch"} added no commits; its worktree is removed.`;
		case "conflict":
			return `Rebasing ${integration.branch} onto the clone's branch conflicted in:\n${integration.files.join("\n") || "(files not listed)"}\nThe rebase was aborted and the clone is unchanged; the branch ${integration.branch} and its worktree ${integration.dir} are kept to resolve.`;
		case "refused":
			return `Not merged: ${integration.reason}\nThe branch ${integration.branch} and its worktree ${integration.dir} are kept.`;
		default:
			return undefined;
	}
}

export function codingReport(result: CodingResult, started: string): string {
	const { job, outcome, state, commits, held, autoApproved, integration } =
		result;
	const merge = integrationText(integration, job.branch);
	return [
		`## Coding task #${job.id}: ${job.repo}`,
		`Started: ${started}`,
		outcome.ok ? outcome.report : outcome.error,
		"### Held",
		held.length ? held.join("\n") : "None.",
		...(autoApproved?.length
			? ["### Approved by yolo mode", autoApproved.join("\n")]
			: []),
		"### Repository",
		[
			...(merge ? [merge] : []),
			state
				? `Branch ${state.branch}, HEAD ${state.head} (was ${job.startHead}).\nNew commits:\n${commits.join("\n") || "None."}\nUncommitted:\n${state.uncommitted.join("\n") || "None."}`
				: "Unreadable.",
		].join("\n"),
		"Review the changes and checks, then use repo_change_report before repo_push.",
	].join("\n\n");
}
