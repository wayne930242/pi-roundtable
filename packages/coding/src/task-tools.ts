import {
	defineTool,
	type ToolContribution,
	type ToolTurn,
} from "pi-roundtable";
import { AgentError } from "pi-roundtable/kit";
import { type TString, Type } from "typebox";
import type { CodingDesk } from "./coding-desk.ts";
import type { RepoToolName } from "./coding-options.ts";
import { callerName, mayControl, taskLine } from "./task-control.ts";

/** The repo_task_list answer: the running and queued tasks the turn may see. */
export function listTasks(
	desk: Pick<CodingDesk, "tasks">,
	turn: ToolTurn,
	repo?: string,
): string {
	const lines = desk
		.tasks()
		.filter(
			({ job }) =>
				(repo === undefined || job.repo === repo) && mayControl(job, turn),
		)
		.map(taskLine);
	return lines.length
		? lines.join("\n")
		: "No running or queued coding tasks you may see.";
}

/** The repo_task_cancel answer; a task the turn may not see is refused as if unknown. */
export async function cancelTask(
	desk: Pick<CodingDesk, "tasks" | "cancel">,
	turn: ToolTurn,
	input: { repo: string; id: number; reason?: string },
): Promise<string> {
	const task = desk
		.tasks()
		.find(({ job }) => job.id === input.id && job.repo === input.repo);
	if (!task)
		throw new AgentError(
			`No running or queued coding task #${input.id} in ${input.repo}; it may have finished already. repo_task_list shows the tasks.`,
		);
	if (!mayControl(task.job, turn))
		throw new AgentError(
			`Coding task #${input.id} was started by someone else; only they or an owner may cancel it.`,
		);
	const reason = input.reason?.trim();
	const by = `${callerName(turn)}${reason ? ` (${reason.slice(0, 200)})` : ""}`;
	const result = await desk.cancel(input.id, by);
	switch (result.status) {
		case "refused":
			throw new AgentError(result.reason);
		case "dropped":
			return `Dropped coding task #${input.id} in ${input.repo} from the queue; it never ran.`;
		case "stopped": {
			const kept = result.branch
				? ` Its commits (${result.commits.length}) are kept, not merged, on the branch ${result.branch}${result.dir ? ` in the worktree ${result.dir}` : ""}; inspect, merge or delete them.`
				: " It had not made its worktree yet.";
			const pending = result.settled
				? ""
				: " The worker is still stopping; its report follows.";
			return `Stopped coding task #${input.id} in ${input.repo}.${kept}${pending}`;
		}
	}
}

/** The repo_task_list and repo_task_cancel tools, worded like the other repository tools. */
export function taskTools(
	desk: CodingDesk,
	refusal: <T>(operation: () => Promise<T>) => Promise<T>,
	describe: (tool: RepoToolName, fallback: string) => string,
	about: (
		tool: RepoToolName,
		name: string,
		fallback?: string,
	) => { description?: string },
	repoSchema: (tool: RepoToolName) => TString,
): ToolContribution[] {
	return [
		defineTool({
			name: "repo_task_list",
			minTier: "owner",
			description: describe(
				"repo_task_list",
				"List running and queued coding tasks with id, repository, who started each, when, and the first line of its task. An agent sees the tasks it started; an owner sees all.",
			),
			parameters: Type.Object({
				repo: Type.Optional(
					Type.String(
						about(
							"repo_task_list",
							"repo",
							"Only this repository, owner/repo.",
						),
					),
				),
			}),
			run: ({ repo }, turn) => refusal(async () => listTasks(desk, turn, repo)),
		}),
		defineTool({
			name: "repo_task_cancel",
			minTier: "owner",
			description: describe(
				"repo_task_cancel",
				"Cancel a coding task by id. A queued task is dropped and never runs; a running worker is stopped, and its commits stay on its branch and worktree, not merged into the clone. An agent may cancel the tasks it started; an owner may cancel any.",
			),
			parameters: Type.Object({
				repo: repoSchema("repo_task_cancel"),
				id: Type.Integer({
					minimum: 1,
					...about("repo_task_cancel", "id", "The task's number, as #N."),
				}),
				reason: Type.Optional(
					Type.String({
						maxLength: 200,
						...about("repo_task_cancel", "reason", "Why, for its report."),
					}),
				),
			}),
			run: (input, turn) => refusal(() => cancelTask(desk, turn, input)),
		}),
	];
}
