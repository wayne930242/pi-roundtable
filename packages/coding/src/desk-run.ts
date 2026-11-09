import type { HeldCall } from "pi-roundtable";
import {
	AgentError,
	approvalCard,
	approvalDetails,
	InterimPoster,
	promptSlot,
} from "pi-roundtable/kit";
import { codingReport } from "./coding-report.ts";
import type { DeskModes } from "./desk-modes.ts";
import type {
	CodingDeskOptions,
	CodingJob,
	CodingResult,
	HeldCallAnswer,
} from "./desk-types.ts";
import type { RepoGate } from "./repo-gate.ts";
import type { Integration, RepoState, WorkerTree } from "./repo-shelf.ts";
import {
	cancelledText,
	interruptedText,
	notMergedReason,
	stoppedOutsideText,
} from "./task-control.ts";
import { CodingWorkerFailure } from "./worker-failure.ts";

const MAX_REPORT_CHARS = 20_000;
const MAX_HELD_ENTRIES = 10;
const MAX_HELD_CHARS = 1_000;
function bounded(text: string, max: number): string {
	const suffix = "\n[truncated]";
	return text.length > max
		? `${text.slice(0, max - suffix.length)}${suffix}`
		: text;
}

/** One task's state while it runs; the desk keeps it until the worker settles. */
export interface Running {
	job: CodingJob;
	controller: AbortController;
	done?: Promise<void>;
	/** Who cancelled it; its branch is then kept, not merged. */
	cancelledBy?: string;
	/** The host's shutdown told it to stop; its branch is then kept, not merged. */
	interrupted?: boolean;
	/** Resolves with its kept commits once the worker settles. */
	settled?: Promise<string[]>;
	settle?: (commits: string[]) => void;
	/** Its worktree, once made. */
	dir?: string;
}

/** What a run takes from the desk that started it. */
export interface RunContext {
	options: CodingDeskOptions;
	modes: DeskModes;
	gate: RepoGate;
	/** Frees the job's slot and starts the next queued tasks. */
	free(job: CodingJob): void;
	/** Delivers a report, which a shutdown waits for meanwhile. */
	deliver(result: CodingResult): Promise<void>;
}

/**
 * One task from worktree to delivered report: runs the worker, answers its held calls, integrates its
 * branch, and hands the report to the desk to deliver.
 */
export async function runCodingJob(
	ctx: RunContext,
	job: CodingJob,
	run: Running,
): Promise<void> {
	const { controller } = run;
	const { shelf, worker, prompts, threads, threadText } = ctx.options;
	const slot = promptSlot();
	const held: string[] = [];
	const autoApproved: string[] = [];
	let omittedHeld = 0;
	let omittedApproved = 0;
	const maxReport = ctx.options.limits?.reportChars ?? MAX_REPORT_CHARS;
	const maxHeldEntries = ctx.options.limits?.heldEntries ?? MAX_HELD_ENTRIES;
	const maxHeldChars = ctx.options.limits?.heldChars ?? MAX_HELD_CHARS;
	let cancel = () => {};
	let interim: InterimPoster | undefined;
	let timedOut: number | undefined;
	let stoppedOutside = false;
	let tree: WorkerTree | undefined;
	let outcome: CodingResult["outcome"];
	try {
		tree = await shelf.addWorktree(job.repo, job.id);
		job.startHead = tree.base.slice(0, 12);
		job.branch = tree.branch;
		run.dir = tree.dir;
		if (controller.signal.aborted)
			throw new AgentError("the worker was stopped");
		if (threads) {
			try {
				const thread = await threads.open(
					job.origin,
					`${job.repo} #${job.id}`,
					threadText?.initial?.(job) ?? `Task:\n${job.task}`,
				);
				if (thread) job.thread = thread;
			} catch {
				ctx.options.logger.warn({ job: job.id }, "Coding thread unavailable.");
			}
		}
		if (controller.signal.aborted)
			throw new AgentError("the worker was stopped");
		// The worker's progress goes to its thread as it works, under the report's name.
		if (job.thread?.interim && ctx.options.interimText !== "off")
			interim = new InterimPoster(job.thread.interim, {
				logger: ctx.options.logger,
				channel: job.thread.channel,
				...(ctx.options.interimPrimaryChars
					? { primaryChars: ctx.options.interimPrimaryChars }
					: {}),
			});
		const poster = interim;
		slot.bind(
			threads
				? job.thread && prompts?.(job.thread.channel)
				: prompts?.(job.channel),
			`Coding worker #${job.id}`,
			poster ? () => poster.flush() : undefined,
		);
		cancel = ctx.modes.budget(job, slot, (worked) => {
			timedOut = worked;
			controller.abort();
		});
		const review = async (call: HeldCall): Promise<HeldCallAnswer> => {
			// The starter's yolo mode answers for a call it may approve, read at the time of the call.
			if (!controller.signal.aborted && ctx.modes.yolo(job, call)) {
				if (autoApproved.length < maxHeldEntries)
					autoApproved.push(
						bounded(`${call.action}: ${call.tool} ${call.input}`, maxHeldChars),
					);
				else omittedApproved++;
				return "approved";
			}
			let answer: HeldCallAnswer = "held";
			try {
				const decision = await slot.prompts?.confirm(
					threadText?.approvalTitle?.(job) ?? `${slot.asker} requests approval`,
					approvalCard(call),
					controller.signal,
					undefined,
					undefined,
					approvalDetails(call),
				);
				if (decision === "approved" || decision === "declined")
					answer = decision;
			} catch {
				/* A failed card never authorizes the call. */
			}
			// A call the owner declined is settled, not held for the report.
			if (answer === "held") {
				if (held.length < maxHeldEntries) {
					const entry = bounded(
						`${call.action}: ${call.tool} ${call.input}`,
						maxHeldChars,
					);
					held.push(entry);
					try {
						await interim?.flush();
						await job.thread?.post(
							threadText?.held?.(entry, job) ?? `Held: ${entry}`,
						);
					} catch {
						/* A failed progress post does not discard the held action. */
					}
				} else omittedHeld++;
			}
			return answer;
		};
		const report = await worker.run(
			{ ...job, dir: tree.dir },
			controller.signal,
			review,
			interim,
		);
		if (controller.signal.aborted)
			throw new AgentError("the worker was stopped");
		outcome = { ok: true, report: bounded(report, maxReport) };
	} catch (error) {
		// The host's own refusals and the worker's scrubbed, bounded error text reach the report.
		let message =
			"The worker failed; inspect the clone and worker configuration on the host.";
		if (error instanceof AgentError) message = error.message;
		if (error instanceof CodingWorkerFailure) {
			if (error.category === "stopped" && !controller.signal.aborted)
				stoppedOutside = true;
			ctx.options.logger.warn(
				{ job: job.id, category: error.category, exitCode: error.exitCode },
				"Coding worker failed.",
			);
		}
		if (controller.signal.aborted) message = "the worker was stopped";
		if (stoppedOutside) message = stoppedOutsideText;
		if (run.interrupted) message = interruptedText;
		if (timedOut !== undefined)
			message = `the worker ran out of time (${Math.round(timedOut / 60_000)} minutes)`;
		if (run.cancelledBy !== undefined) message = cancelledText(run.cancelledBy);
		outcome = { ok: false, error: message };
	} finally {
		cancel();
		slot.unbind();
		// What the worker wrote lands before its report.
		await interim?.flush();
	}
	let integration: Integration | undefined;
	// An aborted worker's commits stay on its branch for the owner to inspect, merge or delete.
	if (tree && (controller.signal.aborted || run.interrupted || stoppedOutside))
		integration = {
			status: "refused",
			branch: tree.branch,
			dir: tree.dir,
			reason: notMergedReason({ ...run, timedOut, stoppedOutside }),
		};
	else if (tree)
		try {
			integration = await ctx.gate.integrate(tree);
		} catch (error) {
			integration = {
				status: "refused",
				branch: tree.branch,
				dir: tree.dir,
				reason:
					error instanceof AgentError
						? error.message
						: "the merge failed; inspect the clone and the worktree on the host",
			};
		}
	let state: RepoState | undefined;
	let commits: string[] = [];
	try {
		if (
			tree &&
			(integration?.status === "conflict" || integration?.status === "refused")
		) {
			// The work stays on its branch: describe the worktree.
			state = await shelf.treeState(tree);
			commits = await shelf.treeCommits(tree);
		} else {
			state = await shelf.state(job.repo);
			if (integration?.status === "merged") commits = integration.commits;
		}
	} catch {
		ctx.options.logger.warn({ job: job.id }, "Repository state unreadable.");
	}
	if (omittedHeld)
		held.push(`[${omittedHeld} more unapproved actions omitted]`);
	if (omittedApproved)
		autoApproved.push(`[${omittedApproved} more approved actions omitted]`);
	const result: CodingResult = {
		job,
		outcome,
		held,
		...(autoApproved.length ? { autoApproved } : {}),
		...(state ? { state } : {}),
		commits,
		...(integration ? { integration } : {}),
	};
	try {
		await job.thread?.close(
			bounded(
				threadText?.report?.(result) ??
					codingReport(result, job.startedAt.toISOString()),
				maxReport,
			),
		);
	} catch {
		ctx.options.logger.warn({ job: job.id }, "Coding thread close failed.");
	}
	run.settle?.(commits);
	// The work is over: free the slot and the repository before the report turn, so that turn can ship it.
	ctx.free(job);
	await ctx.deliver(result);
}
