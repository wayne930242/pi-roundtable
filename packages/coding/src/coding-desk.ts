import type {
	ChannelKey,
	HeldCall,
	Logger,
	OwnerPrompts,
	ThinkingLevel,
} from "pi-roundtable";
import {
	AgentError,
	approvalCard,
	type DispatchThread,
	type DispatchThreads,
	promptSlot,
	workTimeout,
} from "pi-roundtable/kit";
import type { RepoShelf, RepoState } from "./repo-shelf.ts";
import { CodingWorkerFailure } from "./worker-failure.ts";

export type HeldCallAnswer = "approved" | "declined" | "held";
export interface CodingJob {
	id: number;
	repo: string;
	task: string;
	channel: ChannelKey;
	/** The calling turn's channel, where a progress thread opens. */
	origin?: ChannelKey;
	/** Host-resolved names of the skills carried to this run. */
	skillNames?: string[];
	/** Progress thread, when the surface supports one. */
	thread?: DispatchThread;
	model: string;
	thinking: ThinkingLevel;
	skillFiles: string[];
	startedAt: Date;
	startHead: string;
}
export interface CodingWorker {
	run(
		job: CodingJob & { dir: string },
		signal: AbortSignal,
		review: (call: HeldCall) => Promise<HeldCallAnswer>,
	): Promise<string>;
}
export interface CodingResult {
	job: CodingJob;
	outcome: { ok: true; report: string } | { ok: false; error: string };
	held: string[];
	state?: RepoState;
	commits: string[];
}
export interface CodingThreadText {
	initial?(job: CodingJob): string;
	held?(entry: string, job: CodingJob): string;
	approvalTitle?(job: CodingJob): string;
	report?(result: CodingResult): string;
}
export interface CodingDeskOptions {
	shelf: Pick<RepoShelf, "dirOf" | "state" | "commitsSince">;
	worker: CodingWorker;
	prompts?(channel: ChannelKey): OwnerPrompts | undefined;
	/** When configured, approval cards stay in the job's thread; no thread means held. */
	threads?: Pick<DispatchThreads, "open">;
	threadText?: CodingThreadText;
	deliver(result: CodingResult): Promise<void>;
	logger: Logger;
	timeoutMs?: number;
}
export const MAX_CODING_TASK_CHARS = 8_000;
const MAX_REPORT_CHARS = 20_000;
const MAX_HELD_ENTRIES = 10;
const MAX_HELD_CHARS = 1_000;
function bounded(text: string, max: number): string {
	const suffix = "\n[truncated]";
	return text.length > max
		? `${text.slice(0, max - suffix.length)}${suffix}`
		: text;
}

/** One worker per repository, at most three per channel; results and jobs are in memory. */
export class CodingDesk {
	readonly #options: CodingDeskOptions;
	readonly #running = new Map<
		number,
		{ job: CodingJob; controller: AbortController; done?: Promise<void> }
	>();
	#nextId = 1;
	#stopped = false;
	constructor(options: CodingDeskOptions) {
		if (
			!Number.isFinite(options.timeoutMs ?? 3_600_000) ||
			(options.timeoutMs ?? 3_600_000) <= 0 ||
			(options.timeoutMs ?? 3_600_000) > 2_147_483_647
		)
			throw new AgentError(
				"timeoutMs must be positive, finite and at most 2147483647.",
			);
		this.#options = options;
	}
	runningChannels(): ChannelKey[] {
		return [...this.#running.values()].map(({ job }) => job.channel);
	}
	busy(): string[] {
		return [...this.#running.values()].map(
			({ job }) => `Coding #${job.id} in ${job.repo}`,
		);
	}
	checkIdle(repo: string): void {
		if ([...this.#running.values()].some(({ job }) => job.repo === repo))
			throw new AgentError(`A coding worker is still using ${repo}.`);
	}
	async idle(): Promise<void> {
		await Promise.all([...this.#running.values()].map((run) => run.done));
	}
	async stop(): Promise<void> {
		this.#stopped = true;
		for (const run of this.#running.values()) run.controller.abort();
		await this.idle();
	}
	async start(
		request: Omit<CodingJob, "id" | "startedAt" | "startHead" | "thread">,
	): Promise<CodingJob> {
		if (this.#stopped) throw new AgentError("The coding desk is stopped.");
		const task = request.task.trim();
		if (!task || task.length > MAX_CODING_TASK_CHARS)
			throw new AgentError(
				`The task must contain 1–${MAX_CODING_TASK_CHARS} characters.`,
			);
		const dir = this.#options.shelf.dirOf(request.repo);
		this.checkIdle(request.repo);
		if (
			[...this.#running.values()].filter(
				({ job }) => job.channel === request.channel,
			).length >= 3
		)
			throw new AgentError("This channel already has three coding workers.");
		const job: CodingJob = {
			...request,
			task,
			id: this.#nextId++,
			startedAt: new Date(),
			startHead: "",
		};
		const run = {
			job,
			controller: new AbortController(),
			done: undefined as Promise<void> | undefined,
		};
		this.#running.set(job.id, run);
		// Reserve before the first await, including startup state reads.
		run.done = this.#run(job, dir, run.controller)
			.catch(() => {
				this.#options.logger.error(
					{ job: job.id },
					"Coding report delivery failed.",
				);
			})
			.finally(() => this.#running.delete(job.id));
		return job;
	}
	async #run(
		job: CodingJob,
		dir: string,
		controller: AbortController,
	): Promise<void> {
		const {
			shelf,
			worker,
			prompts,
			threads,
			threadText,
			deliver,
			timeoutMs = 3_600_000,
		} = this.#options;
		const slot = promptSlot();
		const held: string[] = [];
		let omittedHeld = 0;
		let cancel = () => {};
		let timedOut = false;
		let outcome: CodingResult["outcome"];
		try {
			job.startHead = (await shelf.state(job.repo)).head;
			if (controller.signal.aborted)
				throw new AgentError("The worker was stopped.");
			if (threads) {
				try {
					const thread = await threads.open(
						job.origin,
						`${job.repo} #${job.id}`,
						threadText?.initial?.(job) ?? `Task:\n${job.task}`,
					);
					if (thread) job.thread = thread;
				} catch {
					this.#options.logger.warn(
						{ job: job.id },
						"Coding thread unavailable.",
					);
				}
			}
			if (controller.signal.aborted)
				throw new AgentError("The worker was stopped.");
			slot.bind(
				threads
					? job.thread && prompts?.(job.thread.channel)
					: prompts?.(job.channel),
				`Coding worker #${job.id}`,
			);
			cancel = workTimeout(timeoutMs, slot, () => {
				timedOut = true;
				controller.abort();
			});
			const review = async (call: HeldCall): Promise<HeldCallAnswer> => {
				let answer: HeldCallAnswer = "held";
				try {
					const decision = await slot.prompts?.confirm(
						threadText?.approvalTitle?.(job) ??
							`${slot.asker} requests approval`,
						approvalCard(call),
						controller.signal,
					);
					if (decision === "approved" || decision === "declined")
						answer = decision;
				} catch {
					/* A failed card never authorizes the call. */
				}
				if (answer !== "approved") {
					if (held.length < MAX_HELD_ENTRIES) {
						const entry = bounded(
							`${answer}: ${call.action}: ${call.tool} ${call.input}`,
							MAX_HELD_CHARS,
						);
						held.push(entry);
						try {
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
				{ ...job, dir },
				controller.signal,
				review,
			);
			if (controller.signal.aborted)
				throw new AgentError("The worker was stopped.");
			outcome = { ok: true, report: bounded(report, MAX_REPORT_CHARS) };
		} catch (error) {
			// Only structured, fixed diagnostics can cross the worker boundary.
			let message =
				"The worker failed; inspect the clone and worker configuration on the host.";
			if (error instanceof CodingWorkerFailure) {
				message = error.message;
				this.#options.logger.warn(
					{ job: job.id, category: error.category, exitCode: error.exitCode },
					"Coding worker failed.",
				);
			}
			if (controller.signal.aborted) message = "The worker was stopped.";
			if (timedOut)
				message = `Work timeout after ${timeoutMs} ms (owner wait excluded).`;
			outcome = { ok: false, error: message };
		} finally {
			cancel();
			slot.unbind();
		}
		let state: RepoState | undefined;
		let commits: string[] = [];
		try {
			state = await shelf.state(job.repo);
			if (job.startHead)
				commits = await shelf.commitsSince(job.repo, job.startHead);
		} catch {
			this.#options.logger.warn(
				{ job: job.id },
				"Repository state unreadable.",
			);
		}
		if (omittedHeld)
			held.push(`[${omittedHeld} more unapproved actions omitted]`);
		const result: CodingResult = {
			job,
			outcome,
			held,
			...(state ? { state } : {}),
			commits,
		};
		try {
			await job.thread?.close(
				bounded(
					threadText?.report?.(result) ??
						codingReport(result, job.startedAt.toISOString()),
					MAX_REPORT_CHARS,
				),
			);
		} catch {
			this.#options.logger.warn({ job: job.id }, "Coding thread close failed.");
		}
		await deliver(result);
	}
}

export function codingReport(result: CodingResult, started: string): string {
	const { job, outcome, state, commits, held } = result;
	return [
		`## Coding task #${job.id}: ${job.repo}`,
		`Started: ${started}`,
		outcome.ok ? outcome.report : outcome.error,
		"### Held",
		held.length ? held.join("\n") : "None.",
		"### Repository",
		state
			? `Branch ${state.branch}, HEAD ${state.head} (was ${job.startHead}).\nNew commits:\n${commits.join("\n") || "None."}\nUncommitted:\n${state.uncommitted.join("\n") || "None."}`
			: "Unreadable.",
		"Review the changes and checks, then use repo_change_report before repo_push.",
	].join("\n\n");
}
