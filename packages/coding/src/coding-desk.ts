import type { ChannelKey } from "pi-roundtable";
import { AgentError } from "pi-roundtable/kit";
import { DeskModes } from "./desk-modes.ts";
import { type RunContext, type Running, runCodingJob } from "./desk-run.ts";
import type {
	CodingDeskOptions,
	CodingJob,
	CodingResult,
	CodingStart,
} from "./desk-types.ts";
import { checkCount, checkMaxWorkers } from "./limits.ts";
import { RepoGate } from "./repo-gate.ts";
import {
	type CancelResult,
	type CodingTask,
	droppedText,
	hostStopping,
	notStartedText,
	within,
} from "./task-control.ts";

export { codingReport, integrationText } from "./coding-report.ts";
export type {
	CodingAutonomy,
	CodingDeskOptions,
	CodingJob,
	CodingLimits,
	CodingModes,
	CodingProgress,
	CodingResult,
	CodingSpeaker,
	CodingStart,
	CodingStarter,
	CodingThreadText,
	CodingWorker,
	HeldCallAnswer,
} from "./desk-types.ts";
export { checkLimit } from "./limits.ts";

export const MAX_CODING_TASK_CHARS = 8_000;

const DEFAULT_MAX_WORKERS = 4;
const DEFAULT_MAX_QUEUED = 16;
const DEFAULT_STOP_WAIT_MS = 15_000;

/**
 * Up to `maxWorkers` workers at once, each in its own worktree; more tasks wait in a FIFO queue.
 * A finished worker's branch is rebased onto its clone and fast-forwarded, one clone at a time.
 * Results and jobs are in memory.
 */
export class CodingDesk {
	readonly #options: CodingDeskOptions;
	#maxWorkers: number;
	readonly #maxQueued: number;
	readonly #modes: DeskModes;
	/** Every run until its report is delivered, for idle(). */
	readonly #pending = new Set<Promise<void>>();
	readonly #running = new Map<number, Running>();
	readonly #queue: CodingJob[] = [];
	readonly #gate: RepoGate;
	/** The channels of reports being delivered, one entry each, until `deliver` settles. */
	readonly #delivering: ChannelKey[] = [];
	#nextId = 1;
	#stopped = false;
	/** The host's shutdown is waiting for work: nothing new starts. */
	#draining = false;
	constructor(options: CodingDeskOptions) {
		this.#modes = new DeskModes(options);
		this.#maxWorkers = options.maxWorkers ?? DEFAULT_MAX_WORKERS;
		this.#maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
		checkMaxWorkers(this.#maxWorkers);
		checkCount("maxQueued", this.#maxQueued, 0);
		this.#options = options;
		this.#gate = new RepoGate(options.shelf);
	}
	/** The channels of running workers. */
	runningChannels(): ChannelKey[] {
		return [...this.#running.values()].map(({ job }) => job.channel);
	}
	/** The channels of queued tasks, in queue order. */
	queuedChannels(): ChannelKey[] {
		return this.#queue.map((job) => job.channel);
	}
	/**
	 * The channels of work a shutdown waits for: running tasks, and the reports of finished or
	 * dropped ones still being delivered, which a stop must not cut off. Queued tasks are not
	 * among them: `beginDrain` drops them.
	 */
	busyChannels(): ChannelKey[] {
		return [...this.runningChannels(), ...this.#delivering];
	}
	/** Workers allowed at once, and how many run and wait now. */
	workers(): { max: number; running: number; queued: number } {
		const { size: running } = this.#running;
		return { max: this.#maxWorkers, running, queued: this.#queue.length };
	}
	/** Sets the workers run at once, 1 to 64: a higher limit starts queued tasks now; a lower one stops none. */
	setMaxWorkers(max: number): void {
		checkMaxWorkers(max);
		this.#maxWorkers = max;
		this.#fill();
	}
	busy(): string[] {
		return [
			...[...this.#running.values()].map(
				({ job }) => `Coding #${job.id} in ${job.repo}`,
			),
			...this.#queue.map(
				(job, index) =>
					`Coding #${job.id} in ${job.repo}, queued (position ${index + 1})`,
			),
		];
	}
	/** Refuses while a worker's branch is being merged into the clone; running workers do not count. */
	checkIdle(repo: string): void {
		this.#gate.checkIdle(repo);
	}
	/** Whether a report or push is in progress for the repository. */
	shipping(repo: string): boolean {
		return this.#gate.shipping(repo);
	}
	/** Runs a report or push of the repository, one at a time; see `RepoGate.ship`. */
	ship<T>(repo: string, operation: () => Promise<T>): Promise<T> {
		return this.#gate.ship(repo, operation);
	}
	async idle(): Promise<void> {
		// A run that ends starts the next queued one before it settles, so look again.
		while (this.#pending.size) await Promise.all(this.#pending);
	}
	/** The running tasks, then the queued ones in queue order. */
	tasks(): CodingTask[] {
		return [
			...[...this.#running.values()].map(({ job }) => ({
				job,
				status: "running" as const,
			})),
			...this.#queue.map((job, index) => ({
				job,
				status: "queued" as const,
				queuePosition: index + 1,
			})),
		];
	}
	/**
	 * Cancels a task: a queued one never starts; a running one is stopped as a timeout stops it,
	 * and its commits stay on its branch and worktree, not merged. Waits up to `waitMs` for the
	 * worker to settle; the report reaches `deliver` as for any run.
	 */
	async cancel(id: number, by: string, waitMs = 30_000): Promise<CancelResult> {
		const queued = this.#queue.findIndex((job) => job.id === id);
		if (queued !== -1) {
			const [job] = this.#queue.splice(queued, 1);
			if (!job) throw new Error("unreachable");
			this.#track(this.#drop(job, droppedText(by)));
			return { status: "dropped", job };
		}
		const run = this.#running.get(id);
		if (!run || run.cancelledBy !== undefined)
			return {
				status: "refused",
				reason: `No running or queued coding task #${id}; it may have finished already.`,
			};
		run.cancelledBy = by;
		run.controller.abort();
		const commits = run.settled && (await within(run.settled, waitMs));
		const { job } = run;
		return {
			status: "stopped",
			job,
			...(job.branch ? { branch: job.branch } : {}),
			...(run.dir ? { dir: run.dir } : {}),
			commits: commits ?? [],
			settled: commits !== undefined,
		};
	}
	/**
	 * The host's shutdown began waiting for work: no queued task starts and `start` refuses, so the
	 * drain waits for the running workers only. Each queued task gets a report at once that it did
	 * not start, with the time left to deliver it before the queue is sealed.
	 */
	beginDrain(): void {
		this.#draining = true;
		for (const job of this.#queue.splice(0))
			this.#track(this.#drop(job, notStartedText));
	}
	/**
	 * The host's drain ran out of time: tells each running worker to stop, as a cancel does, so its
	 * commits stay on its branch and its report names the worktree, and drops the queued tasks with
	 * a report that they never ran. Starts nothing more. Whether any task was told.
	 */
	interrupt(): boolean {
		this.#stopped = true;
		const queued = this.#queue.splice(0);
		for (const job of queued) this.#track(this.#drop(job));
		let told = queued.length > 0;
		for (const run of this.#running.values()) {
			if (run.interrupted) continue;
			run.interrupted = true;
			run.controller.abort(hostStopping);
			told = true;
		}
		return told;
	}
	/**
	 * Stops the running workers as a host shutdown does and drops the queued tasks, telling each
	 * that it never ran. Waits at most `stopWaitMs` for the reports: a report turn that is still
	 * going then is left behind, not waited for.
	 */
	async stop(): Promise<void> {
		this.#stopped = true;
		for (const job of this.#queue.splice(0)) this.#track(this.#drop(job));
		for (const run of this.#running.values()) {
			run.interrupted = true;
			run.controller.abort(hostStopping);
		}
		const waited = this.#options.stopWaitMs ?? DEFAULT_STOP_WAIT_MS;
		const ended = await within(
			this.idle().then(() => true),
			waited,
		);
		if (!ended)
			this.#options.logger.warn(
				{ waitedMs: waited },
				"Coding reports still going out; not waiting for them.",
			);
	}
	async start(
		request: Omit<CodingJob, "id" | "startedAt" | "startHead" | "thread">,
	): Promise<CodingStart> {
		if (this.#stopped) throw new AgentError("The coding desk is stopped.");
		if (this.#draining) throw new AgentError(notStartedText);
		const task = request.task.trim();
		if (!task) throw new AgentError("The task is required.");
		if (task.length > MAX_CODING_TASK_CHARS)
			throw new AgentError(
				`The task is ${task.length} characters; keep it within ${MAX_CODING_TASK_CHARS}.`,
			);
		this.#options.shelf.dirOf(request.repo);
		const full = this.#running.size >= this.#maxWorkers;
		if (full && this.#queue.length >= this.#maxQueued)
			throw new AgentError(
				`All ${this.#maxWorkers} coding workers are busy and ${this.#queue.length} tasks are already waiting; try again after one reports back.`,
			);
		const now = new Date();
		const job: CodingJob = {
			...request,
			task,
			id: this.#nextId++,
			queuedAt: now,
			startedAt: now,
			startHead: "",
		};
		// Reserve before the first await, including startup state reads.
		if (!full) {
			this.#launch(job);
			return job;
		}
		this.#queue.push(job);
		return { ...job, queuePosition: this.#queue.length };
	}
	#track(done: Promise<void>): void {
		this.#pending.add(done);
		void done.finally(() => this.#pending.delete(done));
	}
	#launch(job: CodingJob): void {
		job.startedAt = new Date();
		const run: Running = { job, controller: new AbortController() };
		run.settled = new Promise((resolve) => {
			run.settle = resolve;
		});
		this.#running.set(job.id, run);
		run.done = runCodingJob(this.#context(), job, run)
			.catch(() => {
				this.#options.logger.error(
					{ job: job.id },
					"Coding report delivery failed.",
				);
			})
			.finally(() => {
				run.settle?.([]);
				this.#free(job);
			});
		this.#track(run.done);
	}
	/** Frees the job's slot and starts the next queued tasks. */
	#free(job: CodingJob): void {
		this.#running.delete(job.id);
		this.#fill();
	}
	#fill(): void {
		while (
			!this.#stopped &&
			!this.#draining &&
			this.#running.size < this.#maxWorkers &&
			this.#queue.length
		) {
			const next = this.#queue.shift();
			if (next) this.#launch(next);
		}
	}
	async #drop(
		job: CodingJob,
		error = "the host stopped before this queued task started; nothing ran, so start it again",
	): Promise<void> {
		try {
			await this.#deliver({
				job,
				outcome: { ok: false, error },
				held: [],
				commits: [],
			});
		} catch {
			this.#options.logger.error(
				{ job: job.id },
				"Coding report delivery failed.",
			);
		}
	}
	#context(): RunContext {
		return {
			options: this.#options,
			modes: this.#modes,
			gate: this.#gate,
			free: (job) => this.#free(job),
			deliver: (result) => this.#deliver(result),
		};
	}
	/** Delivers a report, which a shutdown waits for meanwhile. */
	async #deliver(result: CodingResult): Promise<void> {
		this.#delivering.push(result.job.channel);
		try {
			await this.#options.deliver(result);
		} finally {
			this.#delivering.splice(this.#delivering.indexOf(result.job.channel), 1);
		}
	}
}
