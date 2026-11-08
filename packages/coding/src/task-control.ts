import { SYSTEM_PRINCIPAL, type ToolTurn } from "pi-roundtable";
import type { CodingJob } from "./coding-desk.ts";

/** A running or queued coding task, as `CodingDesk.tasks` lists it. */
export interface CodingTask {
	job: CodingJob;
	status: "running" | "queued";
	/** Its place in the queue, from 1, for a queued task. */
	queuePosition?: number;
}
/** What `CodingDesk.cancel` did. */
export type CancelResult =
	/** The task was queued and is dropped; it never ran. */
	| { status: "dropped"; job: CodingJob }
	/**
	 * The worker was stopped. Its commits stay on `branch` in the worktree `dir`, unmerged;
	 * `settled` is false when the worker had not settled yet as the answer was given.
	 */
	| {
			status: "stopped";
			job: CodingJob;
			branch?: string;
			dir?: string;
			commits: string[];
			settled: boolean;
	  }
	/** No running or queued task has that id. */
	| { status: "refused"; reason: string };

/** What a cancelled run's report says in place of the worker's own. */
export function cancelledText(by: string): string {
	return `cancelled by ${by}; the worker was stopped and its commits were not merged into the clone`;
}
export function droppedText(by: string): string {
	return `cancelled by ${by} before it ran; nothing ran, so start it again if it is still wanted`;
}

/** Whether the turn may see and cancel the job: an owner speaking sees all, an agent its own. */
export function mayControl(job: CodingJob, turn: ToolTurn): boolean {
	const { speaker } = turn;
	if (speaker?.tier === "owner" && speaker.principalId !== SYSTEM_PRINCIPAL)
		return true;
	if (turn.agent) return job.agent === turn.agent.name;
	// Outside an agent's turn, the person who started it, never the host's own turns.
	return (
		job.agent === undefined &&
		speaker !== undefined &&
		speaker.principalId !== SYSTEM_PRINCIPAL &&
		job.starter?.speaker.principalId === speaker.principalId
	);
}

/** Who a turn is, for "cancelled by …". */
export function callerName(turn: ToolTurn): string {
	return (
		turn.speaker?.name ??
		turn.agent?.name ??
		turn.speaker?.principalId ??
		"the host"
	);
}

/** One line for a task in a list. */
export function taskLine(task: CodingTask): string {
	const { job } = task;
	const who = job.agent ?? job.starter?.speaker.name ?? "the owner";
	const when =
		task.status === "running"
			? `running since ${job.startedAt.toISOString()}`
			: `queued (position ${task.queuePosition}) since ${(job.queuedAt ?? job.startedAt).toISOString()}`;
	const first = job.task.split("\n", 1)[0]?.slice(0, 200) ?? "";
	return `#${job.id} ${job.repo}, ${when}, started by ${who}: ${first}`;
}

/** The promise's value, or undefined when it takes longer than `ms`. */
export async function within<T>(
	promise: Promise<T>,
	ms: number,
): Promise<T | undefined> {
	let timer: Timer | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(resolve, ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
