import type {
	ChannelKey,
	DelegationJob,
	DelegationOutcome,
	Logger,
} from "pi-roundtable";
import { DelegationError } from "pi-roundtable";
import { scrubDiagnostic } from "pi-roundtable/kit";

const MAX_TASK_CHARS = 4_000;

export interface ScopedDelegatorOptions {
	target: string;
	maxRunning?: number;
	timeoutMs?: number;
	run(
		task: string,
		context: {
			channel: ChannelKey;
			author: { id: string; name: string };
			signal: AbortSignal;
		},
	): Promise<string>;
	deliver(job: DelegationJob, result: DelegationOutcome): Promise<void>;
	logger: Logger;
}
/** A fixed channel-local target, host-bound author and report destination; no generic host agent dispatcher. */
export class ScopedSandboxDelegator {
	readonly #options: ScopedDelegatorOptions;
	readonly #jobs = new Map<
		number,
		{ controller: AbortController; channel: ChannelKey; done: Promise<void> }
	>();
	#next = 1;
	#closed = false;
	constructor(options: ScopedDelegatorOptions) {
		if (
			!options.target ||
			!Number.isSafeInteger(options.maxRunning ?? 2) ||
			(options.maxRunning ?? 2) < 1 ||
			(options.maxRunning ?? 2) > 10 ||
			!Number.isSafeInteger(options.timeoutMs ?? 600_000) ||
			(options.timeoutMs ?? 600_000) < 1000 ||
			(options.timeoutMs ?? 600_000) > 1_200_000
		)
			throw new Error("Invalid delegation target/budget");
		this.#options = options;
	}
	start(
		request: Omit<DelegationJob, "id" | "startedAt" | "thread">,
	): DelegationJob {
		if (
			this.#closed ||
			request.target !== this.#options.target ||
			request.origin ||
			request.author.tier
		)
			throw new DelegationError("Delegation scope refused");
		const task = request.task.trim();
		if (!request.title.trim() || !task)
			throw new DelegationError("title and task are required");
		if (task.length > MAX_TASK_CHARS)
			throw new DelegationError(
				`the task is ${task.length} characters; keep it within ${MAX_TASK_CHARS}`,
			);
		const busy = [...this.#jobs.values()].filter(
			(job) => job.channel === request.channel,
		).length;
		if (busy >= (this.#options.maxRunning ?? 2))
			throw new DelegationError(
				`this channel already has ${busy} delegated tasks running; wait for one to report back`,
			);
		const job: DelegationJob = {
			id: this.#next++,
			channel: request.channel,
			target: this.#options.target,
			author: { id: request.author.id, name: request.author.name },
			title: request.title.trim(),
			task,
			startedAt: new Date(),
		};
		const controller = new AbortController();
		const signal = AbortSignal.any([
			controller.signal,
			AbortSignal.timeout(this.#options.timeoutMs ?? 600_000),
		]);
		const done = (async () => {
			let result: DelegationOutcome;
			try {
				const report = await this.#options.run(job.task, {
					channel: job.channel,
					author: job.author,
					signal,
				});
				signal.throwIfAborted();
				if (typeof report !== "string" || report.length > 80_000)
					throw new Error("Research report too large");
				result = { ok: true, report };
			} catch (error) {
				// The worker's own reason reaches the asking agent, scrubbed of credentials and bounded.
				const reason = signal.aborted
					? "the worker ran out of time"
					: scrubDiagnostic(
							error instanceof Error ? error.message : String(error),
						);
				result = { ok: false, error: reason || "the task failed" };
			}
			await this.#options.deliver(job, result);
		})()
			.catch(() =>
				this.#options.logger.error(
					{ channel: job.channel, job: job.id },
					"Sandbox task report failed",
				),
			)
			.finally(() => this.#jobs.delete(job.id));
		this.#jobs.set(job.id, { controller, channel: job.channel, done });
		return job;
	}
	runningChannels(): ChannelKey[] {
		return [...this.#jobs.values()].map((job) => job.channel);
	}
	async idle(): Promise<void> {
		await Promise.all([...this.#jobs.values()].map((job) => job.done));
	}
	async dispose(): Promise<void> {
		this.#closed = true;
		for (const job of this.#jobs.values()) job.controller.abort();
		await this.idle();
	}
}
