import type {
	ChannelKey,
	DelegationJob,
	DelegationOutcome,
	Logger,
} from "pi-roundtable";
import { DelegationError } from "pi-roundtable";
import { scrubDiagnostic } from "pi-roundtable/kit";

const MAX_TASK_CHARS = 4_000;
const MAX_TITLE_CHARS = 200;

export interface ScopedDelegatorOptions {
	target: string;
	maxRunning?: number;
	timeoutMs?: number;
	/** Longest title, in characters; default 200. A host whose callers already send longer ones raises it. */
	maxTitleChars?: number;
	/** Longest research report, in characters, or `Infinity`; default 80,000. */
	maxReportChars?: number;
	/** Longest failure reason kept, in characters, or `Infinity`; default 600. */
	diagnosticChars?: number;
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
		if (
			options.maxTitleChars !== undefined &&
			!Number.isSafeInteger(options.maxTitleChars) &&
			options.maxTitleChars !== Number.POSITIVE_INFINITY
		)
			throw new Error("Invalid delegation title limit");
		if (options.maxTitleChars !== undefined && options.maxTitleChars < 1)
			throw new Error("Invalid delegation title limit");
		for (const [name, value] of [
			["maxReportChars", options.maxReportChars],
			["diagnosticChars", options.diagnosticChars],
		] as const)
			if (
				value !== undefined &&
				value !== Number.POSITIVE_INFINITY &&
				(!Number.isSafeInteger(value) || value < 1)
			)
				throw new Error(`Invalid delegation ${name}`);
		this.#options = options;
	}
	start(
		request: Omit<DelegationJob, "id" | "startedAt" | "thread">,
	): DelegationJob {
		// A guest's report runs at the member tier, as the principal the host bound them to.
		if (
			this.#closed ||
			request.target !== this.#options.target ||
			request.origin ||
			request.author.tier !== "member" ||
			!request.author.principalId
		)
			throw new DelegationError("Delegation scope refused");
		const task = request.task.trim();
		if (!request.title.trim() || !task)
			throw new DelegationError("title and task are required");
		const maxTitle = this.#options.maxTitleChars ?? MAX_TITLE_CHARS;
		if (request.title.length > maxTitle)
			throw new DelegationError(
				`the title is ${request.title.length} characters; keep it within ${maxTitle}`,
			);
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
			author: {
				principalId: request.author.principalId,
				id: request.author.id,
				name: request.author.name,
				tier: "member",
			},
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
					author: { id: job.author.id, name: job.author.name },
					signal,
				});
				signal.throwIfAborted();
				if (
					typeof report !== "string" ||
					report.length > (this.#options.maxReportChars ?? 80_000)
				)
					throw new Error("Research report too large");
				result = { ok: true, report };
			} catch (error) {
				// The worker's own reason reaches the asking agent, scrubbed of credentials and bounded.
				const reason = signal.aborted
					? "the worker ran out of time"
					: scrubDiagnostic(
							error instanceof Error ? error.message : String(error),
							this.#options.diagnosticChars,
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
