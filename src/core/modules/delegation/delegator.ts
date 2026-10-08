import type { BackgroundTarget } from "../../contract/channels.ts";
import type {
	DispatchThread,
	DispatchThreads,
} from "../../discord/dispatch-threads.ts";
import type { ChannelKey } from "../../domain/conversation.ts";
import { DelegationError } from "../../domain/errors.ts";
import { messages } from "../../i18n/index.ts";
import type { Logger } from "../../log.ts";
import type { Delegator } from "../../services.ts";
import type { Tier } from "../../speakers.ts";
import { timeZone } from "../../time.ts";

export interface DelegationJob {
	id: number;
	/** Where the report comes back as a turn. */
	channel: ChannelKey;
	/** The channel of the owner's turn that started it, which hosts its thread; absent where no thread opens. */
	origin?: ChannelKey;
	/** The name of the background target the report is answered as. */
	target: string;
	/**
	 * Who asked: their principal, the id and name they spoke as, and their tier; the report is
	 * answered as this person's turn, at that tier or theirs then, whichever is lower.
	 */
	author: { principalId: string; id: string; name: string; tier: Tier };
	title: string;
	task: string;
	startedAt: Date;
	/** Where its report is posted, once opened; absent where no thread could open. */
	thread?: DispatchThread;
}

export type DelegationOutcome =
	| { ok: true; report: string }
	| { ok: false; error: string };

export interface DelegationWorker {
	run(task: string, signal: AbortSignal): Promise<string>;
}

export interface DelegatorOptions {
	worker: DelegationWorker;
	/** Resolves a job's target; an unknown one, or one without `delegation`, is refused with a DelegationError. */
	targets(name: string): BackgroundTarget | undefined;
	/** Posts the finished job back in its channel; never rejects. */
	deliver: (job: DelegationJob, outcome: DelegationOutcome) => Promise<void>;
	/** Each job's thread in its origin; without it every job reports in its channel only. */
	threads?: Pick<DispatchThreads, "open">;
	logger: Logger;
	timeoutMs?: number;
}

const MAX_TASK_CHARS = 4_000;

/**
 * Runs delegated tasks in the background and hands each result back to its channel. Jobs live
 * in memory: a restart drops the running ones, and the channel never hears back from them.
 */
export class DefaultDelegator implements Delegator {
	readonly #options: DelegatorOptions;
	readonly #running = new Map<
		number,
		{ job: DelegationJob; done: Promise<void> }
	>();
	#nextId = 1;

	constructor(options: DelegatorOptions) {
		this.#options = options;
	}

	/** Starts a job and returns at once; throws DelegationError on bad input or a full channel. */
	start(
		request: Omit<DelegationJob, "id" | "startedAt" | "thread">,
	): DelegationJob {
		const title = request.title.trim();
		const task = request.task.trim();
		if (!title || !task)
			throw new DelegationError("title and task are required");
		if (task.length > MAX_TASK_CHARS)
			throw new DelegationError(
				`the task is ${task.length} characters; keep it within ${MAX_TASK_CHARS}`,
			);
		const running = [...this.#running.values()].map(({ job }) => job);
		const busy = running.filter(
			(job) => job.channel === request.channel,
		).length;
		const limits = this.#options.targets(request.target)?.delegation;
		if (limits === undefined)
			throw new DelegationError(
				`delegated tasks are not available for ${request.target} conversations`,
			);
		if (busy >= limits.maxRunning)
			throw new DelegationError(
				`this channel already has ${busy} delegated tasks running; wait for one to report back`,
			);
		const perPrincipal = limits.maxRunningPerPrincipal;
		if (perPrincipal !== undefined) {
			const theirs = running.filter(
				(job) =>
					job.target === request.target &&
					job.author.principalId === request.author.principalId,
			).length;
			if (theirs >= perPrincipal)
				throw new DelegationError(
					`you already have ${theirs} delegated tasks running, the most one person may have here; wait for one to report back`,
				);
		}
		const job: DelegationJob = {
			...request,
			title,
			task,
			id: this.#nextId++,
			startedAt: new Date(),
		};
		const done = this.#run(job).finally(() => this.#running.delete(job.id));
		this.#running.set(job.id, { job, done });
		return job;
	}

	/** The channel of each job still running, one entry per job. */
	runningChannels(): ChannelKey[] {
		return [...this.#running.values()].map(({ job }) => job.channel);
	}

	/** Resolves once every started job has reported. */
	async idle(): Promise<void> {
		await Promise.all([...this.#running.values()].map(({ done }) => done));
	}

	async #run(job: DelegationJob): Promise<void> {
		const {
			worker,
			deliver,
			threads,
			logger,
			timeoutMs = 20 * 60_000,
		} = this.#options;
		logger.info(
			{ job: job.id, channel: job.channel, target: job.target },
			"delegated task started",
		);
		const thread = await threads?.open(
			job.origin,
			job.title,
			messages().delegationTask(job.task),
		);
		if (thread) job.thread = thread;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		let outcome: DelegationOutcome;
		try {
			outcome = {
				ok: true,
				report: await worker.run(job.task, controller.signal),
			};
		} catch (error) {
			outcome = {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		} finally {
			clearTimeout(timer);
		}
		logger.info(
			{ job: job.id, ok: outcome.ok, ms: Date.now() - job.startedAt.getTime() },
			"delegated task finished",
		);
		await thread?.close(
			outcome.ok
				? messages().delegationDone(outcome.report)
				: messages().delegationFailed(outcome.error),
		);
		await deliver(job, outcome).catch((error: unknown) =>
			logger.error({ job: job.id, err: error }, "delegated report not posted"),
		);
	}
}

/** What the asking agent receives when its delegated task reports back. */
export function delegatedTurnText(
	job: DelegationJob,
	outcome: DelegationOutcome,
	localTime: string,
): string {
	const head = [
		`## Delegated task #${job.id}: ${job.title}`,
		...(job.thread
			? [
					`Its task and report are in the thread ${job.thread.mention}, now archived; link it when useful.`,
				]
			: []),
	].join("\n");
	if (!outcome.ok)
		return [
			head,
			`The task handed to the worker model at ${localTime} ${messages().zoneTime(timeZone())} failed: ${outcome.error}. Nobody wrote a new message: tell ${job.author.name} it failed and what you can do instead.`,
		].join("\n");
	return [
		head,
		`The task handed to the worker model at ${localTime} ${messages().zoneTime(timeZone())} has reported back. Nobody wrote a new message: answer ${job.author.name} with it in your own words, keeping the source links.`,
		"",
		"### Task",
		job.task,
		"",
		"### Report",
		outcome.report,
	].join("\n");
}
