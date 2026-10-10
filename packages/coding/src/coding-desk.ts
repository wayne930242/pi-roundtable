import type {
	ChannelKey,
	HeldCall,
	InterimTextMode,
	Logger,
	OwnerPrompts,
	ThinkingLevel,
} from "pi-roundtable";
import {
	AgentError,
	approvalCard,
	type DispatchThread,
	type DispatchThreads,
	InterimPoster,
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
/** What the worker writes and runs as it goes, for its thread's progress posts. */
export interface CodingProgress {
	/** A finished message of the worker's session: its role, stop reason, and text. */
	messageEnd(message: {
		role: string;
		content?: unknown;
		stopReason?: string;
	}): void;
	/** A tool the worker started. */
	toolStart(name: string): void;
}
export interface CodingWorker {
	/** `progress`, when given, hears the session's messages and tools as the worker goes. */
	run(
		job: CodingJob & { dir: string },
		signal: AbortSignal,
		review: (call: HeldCall) => Promise<HeldCallAnswer>,
		progress?: CodingProgress,
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
	limits?: CodingLimits;
	/**
	 * Whether the worker posts the text it writes before its report into its thread as it goes,
	 * as the host's turns do; "on" by default. A thread whose host cannot edit its posts gets none.
	 */
	interimText?: InterimTextMode;
	/** Length from which an intermediate text is posted as its own message; default 400. */
	interimPrimaryChars?: number;
}
/** What a coding report keeps of a long run; each is a count of characters or entries, or `Infinity` for no bound. */
export interface CodingLimits {
	/** Longest worker report, and longest thread report; default 20,000 characters. */
	reportChars?: number;
	/** Held actions listed in the report, the rest counted; default 10. */
	heldEntries?: number;
	/** Longest held-action entry; default 1,000 characters. */
	heldChars?: number;
}
export function checkLimit(name: string, value: number | undefined): void {
	if (
		value !== undefined &&
		value !== Number.POSITIVE_INFINITY &&
		(!Number.isSafeInteger(value) || value < 1)
	)
		throw new Error(
			`${name} must be a whole number of at least 1, or Infinity; got ${value}.`,
		);
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
	/** Every run until its report is delivered, for idle(). */
	readonly #pending = new Set<Promise<void>>();
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
		await Promise.all(this.#pending);
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
		if (!task) throw new AgentError("The task is required.");
		if (task.length > MAX_CODING_TASK_CHARS)
			throw new AgentError(
				`The task is ${task.length} characters; keep it within ${MAX_CODING_TASK_CHARS}.`,
			);
		const dir = this.#options.shelf.dirOf(request.repo);
		const busy = [...this.#running.values()].find(
			({ job }) => job.repo === request.repo,
		);
		if (busy)
			throw new AgentError(
				`Coding task #${busy.job.id} is still working in ${request.repo}; one worker runs per repository.`,
			);
		const inChannel = [...this.#running.values()].filter(
			({ job }) => job.channel === request.channel,
		).length;
		if (inChannel >= 3)
			throw new AgentError(
				`This channel already has ${inChannel} coding workers running; wait for one to report back.`,
			);
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
		const done = run.done;
		this.#pending.add(done);
		void done.finally(() => this.#pending.delete(done));
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
		const maxReport = this.#options.limits?.reportChars ?? MAX_REPORT_CHARS;
		const maxHeldEntries =
			this.#options.limits?.heldEntries ?? MAX_HELD_ENTRIES;
		const maxHeldChars = this.#options.limits?.heldChars ?? MAX_HELD_CHARS;
		let cancel = () => {};
		let interim: InterimPoster | undefined;
		let timedOut = false;
		let outcome: CodingResult["outcome"];
		try {
			job.startHead = (await shelf.state(job.repo)).head;
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
					this.#options.logger.warn(
						{ job: job.id },
						"Coding thread unavailable.",
					);
				}
			}
			if (controller.signal.aborted)
				throw new AgentError("the worker was stopped");
			// The worker's progress goes to its thread as it works, under the report's name.
			if (job.thread?.interim && this.#options.interimText !== "off")
				interim = new InterimPoster(job.thread.interim, {
					logger: this.#options.logger,
					channel: job.thread.channel,
					...(this.#options.interimPrimaryChars
						? { primaryChars: this.#options.interimPrimaryChars }
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
				{ ...job, dir },
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
				this.#options.logger.warn(
					{ job: job.id, category: error.category, exitCode: error.exitCode },
					"Coding worker failed.",
				);
			}
			if (controller.signal.aborted) message = "the worker was stopped";
			if (timedOut)
				message = `the worker ran out of time (${Math.round(timeoutMs / 60_000)} minutes)`;
			outcome = { ok: false, error: message };
		} finally {
			cancel();
			slot.unbind();
			// What the worker wrote lands before its report.
			await interim?.flush();
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
					maxReport,
				),
			);
		} catch {
			this.#options.logger.warn({ job: job.id }, "Coding thread close failed.");
		}
		// The work is over: free the repository before the report turn, so that turn can ship it.
		this.#running.delete(job.id);
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
