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
	describe: (tool: RepoToolName) => string,
	about: (tool: RepoToolName, name: string) => { description?: string },
	repoSchema: (tool: RepoToolName) => TString,
): ToolContribution[] {
	return [
		defineTool({
			name: "repo_task_list",
			minTier: "owner",
			description: describe("repo_task_list"),
			parameters: Type.Object({
				repo: Type.Optional(Type.String(about("repo_task_list", "repo"))),
			}),
			run: ({ repo }, turn) => refusal(async () => listTasks(desk, turn, repo)),
		}),
		defineTool({
			name: "repo_task_cancel",
			minTier: "owner",
			description: describe("repo_task_cancel"),
			parameters: Type.Object({
				repo: repoSchema("repo_task_cancel"),
				id: Type.Integer({
					minimum: 1,
					...about("repo_task_cancel", "id"),
				}),
				reason: Type.Optional(
					Type.String({
						maxLength: 200,
						...about("repo_task_cancel", "reason"),
					}),
				),
			}),
			run: (input, turn) => refusal(() => cancelTask(desk, turn, input)),
		}),
	];
}
