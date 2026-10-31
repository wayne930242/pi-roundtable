import {
	type ChannelKey,
	type ConversationModes,
	type HeldCall,
	type InterimTextMode,
	type Logger,
	type OwnerPrompts,
	SYSTEM_PRINCIPAL,
	type ThinkingLevel,
	type Tier,
} from "pi-roundtable";
import {
	AgentError,
	approvalCard,
	approvalDetails,
	type DispatchThread,
	type DispatchThreads,
	InterimPoster,
	type PromptSlot,
	promptSlot,
	workTimeout,
	YOLO_CARDED_SHELL_CLASSES,
} from "pi-roundtable/kit";
import type {
	Integration,
	RepoShelf,
	RepoState,
	WorkerTree,
} from "./repo-shelf.ts";
import { CodingWorkerFailure } from "./worker-failure.ts";

export type HeldCallAnswer = "approved" | "declined" | "held";
/** Who spoke the turn that started a job, as yolo and long-running modes need to know. */
export interface CodingSpeaker {
	id: string;
	principalId: string;
	name?: string;
	tier?: Tier;
}
/** The conversation whose turn started a job, whose modes the worker follows live. */
export interface CodingStarter {
	channel: ChannelKey;
	speaker: CodingSpeaker;
}
export interface CodingJob {
	id: number;
	repo: string;
	task: string;
	channel: ChannelKey;
	/** The calling turn's channel, where a progress thread opens. */
	origin?: ChannelKey;
	/** The conversation that started it; its yolo and long-running modes apply while it works. */
	starter?: CodingStarter;
	/** Host-resolved names of the skills carried to this run. */
	skillNames?: string[];
	/** Progress thread, when the surface supports one. */
	thread?: DispatchThread;
	model: string;
	thinking: ThinkingLevel;
	skillFiles: string[];
	/** When it was asked for; a queued job starts later. */
	queuedAt?: Date;
	/** When its worker started. */
	startedAt: Date;
	startHead: string;
	/** The worker's own branch, in its own worktree, once it has started. */
	branch?: string;
}
/** A started or queued job, as `CodingDesk.start` answers. */
export type CodingStart = CodingJob & {
	/** Its place in the queue, from 1, when every worker slot is taken; absent when it started. */
	queuePosition?: number;
};
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
	/** Held calls the starter's yolo mode approved without a card. */
	autoApproved?: string[];
	state?: RepoState;
	commits: string[];
	/** How the worker's branch came back into the clone; absent when no worktree was made. */
	integration?: Integration;
}
/** The conversations' modes, read live for each held call and at each work-time limit. */
export type CodingModes = Pick<ConversationModes, "peek"> &
	Partial<Pick<ConversationModes, "autoApproved">>;
/**
 * The host's autonomy limits, as its `autonomy` config resolves them: what yolo may approve, and
 * how long a long-running run works in all.
 */
export interface CodingAutonomy {
	yolo?: { allow?: readonly string[]; card?: readonly string[] };
	/** Default four hours; at most 2147483647. */
	longRunningMaxMs?: number;
}
export interface CodingThreadText {
	initial?(job: CodingJob): string;
	held?(entry: string, job: CodingJob): string;
	approvalTitle?(job: CodingJob): string;
	report?(result: CodingResult): string;
}
export interface CodingDeskOptions {
	shelf: Pick<
		RepoShelf,
		| "dirOf"
		| "state"
		| "addWorktree"
		| "integrate"
		| "treeState"
		| "treeCommits"
	>;
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
	/** Workers running at once on the host, across repositories and channels; default 4. */
	maxWorkers?: number;
	/** Tasks waiting for a worker slot, first in first out; one more is refused. Default 16. */
	maxQueued?: number;
	/**
	 * The conversations' modes: with them a worker follows the yolo and long-running modes of the
	 * conversation that started it, read live, when an owner other than the host spoke that turn.
	 */
	modes?: CodingModes;
	/** The host's autonomy limits for those modes; pass the same values its `autonomy` config sets. */
	autonomy?: CodingAutonomy;
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

const DEFAULT_TIMEOUT_MS = 3_600_000;
/** The core's default long-running ceiling, four hours. */
const DEFAULT_LONG_RUNNING_MS = 4 * 60 * 60_000;
/** How often a run past its own limit looks again at the starter's long-running mode. */
const LONG_RUNNING_STEP_MS = 60_000;
const MAX_TIMER_MS = 2_147_483_647;
const DEFAULT_MAX_WORKERS = 4;
const DEFAULT_MAX_QUEUED = 16;

function checkTime(name: string, value: number): void {
	if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_MS)
		throw new AgentError(
			`${name} must be positive, finite and at most ${MAX_TIMER_MS}.`,
		);
}
function checkCount(name: string, value: number, least: number): void {
	if (!Number.isSafeInteger(value) || value < least)
		throw new AgentError(
			`${name} must be a whole number of at least ${least}; got ${value}.`,
		);
}

/** The rule a class belongs to: the part before its first dot, or a rule's bare name. */
function ruleOf(id: string): string {
	const dot = id.indexOf(".");
	return dot === -1 ? id : id.slice(0, dot);
}

interface Running {
	job: CodingJob;
	controller: AbortController;
	done?: Promise<void>;
}

/**
 * Up to `maxWorkers` workers at once, each in its own worktree; more tasks wait in a FIFO queue.
 * A finished worker's branch is rebased onto its clone and fast-forwarded, one clone at a time.
 * Results and jobs are in memory.
 */
export class CodingDesk {
	readonly #options: CodingDeskOptions;
	readonly #maxWorkers: number;
	readonly #maxQueued: number;
	readonly #longRunningMs: number;
	readonly #yoloApproves: (id: string) => boolean;
	/** Every run until its report is delivered, for idle(). */
	readonly #pending = new Set<Promise<void>>();
	readonly #running = new Map<number, Running>();
	readonly #queue: CodingJob[] = [];
	/** The last integration asked for in each repository, which the next waits for. */
	readonly #integrations = new Map<string, Promise<unknown>>();
	/** Repositories whose clone an integration is changing now. */
	readonly #integrating = new Set<string>();
	/** Reports and pushes in progress, by repository. */
	readonly #shipping = new Map<string, Promise<unknown>>();
	#nextId = 1;
	#stopped = false;
	constructor(options: CodingDeskOptions) {
		checkTime("timeoutMs", options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		const longRunning =
			options.autonomy?.longRunningMaxMs ?? DEFAULT_LONG_RUNNING_MS;
		checkTime("autonomy.longRunningMaxMs", longRunning);
		this.#maxWorkers = options.maxWorkers ?? DEFAULT_MAX_WORKERS;
		this.#maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
		checkCount("maxWorkers", this.#maxWorkers, 1);
		checkCount("maxQueued", this.#maxQueued, 0);
		this.#longRunningMs = longRunning;
		const allow = new Set(options.autonomy?.yolo?.allow ?? []);
		const card = new Set(options.autonomy?.yolo?.card ?? []);
		const carded = new Set<string>(YOLO_CARDED_SHELL_CLASSES);
		// The core's yolo rules: a carded class or rule never, an unclassed call only by its rule's name.
		this.#yoloApproves = (id) => {
			if (card.has(id) || card.has(ruleOf(id))) return false;
			if (!id.includes(".")) return allow.has(id);
			return !carded.has(id) || allow.has(id);
		};
		this.#options = options;
	}
	/** The channels of running workers, which a shutdown waits for; queued tasks are not among them. */
	runningChannels(): ChannelKey[] {
		return [...this.#running.values()].map(({ job }) => job.channel);
	}
	/** The channels of queued tasks, in queue order. */
	queuedChannels(): ChannelKey[] {
		return this.#queue.map((job) => job.channel);
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
		if (this.#integrating.has(repo))
			throw new AgentError(
				`A coding worker's commits are being merged into ${repo}; try again in a moment.`,
			);
	}
	/** Whether a report or push is in progress for the repository. */
	shipping(repo: string): boolean {
		return this.#shipping.has(repo);
	}
	/**
	 * Runs a report or push of the repository, one at a time; refuses during an integration, and
	 * an integration that comes due waits for it.
	 */
	async ship<T>(repo: string, operation: () => Promise<T>): Promise<T> {
		this.checkIdle(repo);
		if (this.#shipping.has(repo))
			throw new AgentError(
				"A report or push is already in progress for this repository.",
			);
		const done = operation();
		this.#shipping.set(
			repo,
			done.catch(() => {}),
		);
		try {
			return await done;
		} finally {
			this.#shipping.delete(repo);
		}
	}
	async idle(): Promise<void> {
		// A run that ends starts the next queued one before it settles, so look again.
		while (this.#pending.size) await Promise.all(this.#pending);
	}
	/** Stops the running workers and drops the queued tasks, telling each that it never ran. */
	async stop(): Promise<void> {
		this.#stopped = true;
		for (const job of this.#queue.splice(0)) this.#track(this.#drop(job));
		for (const run of this.#running.values()) run.controller.abort();
		await this.idle();
	}
	async start(
		request: Omit<CodingJob, "id" | "startedAt" | "startHead" | "thread">,
	): Promise<CodingStart> {
		if (this.#stopped) throw new AgentError("The coding desk is stopped.");
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
		this.#running.set(job.id, run);
		run.done = this.#run(job, run.controller)
			.catch(() => {
				this.#options.logger.error(
					{ job: job.id },
					"Coding report delivery failed.",
				);
			})
			.finally(() => this.#free(job));
		this.#track(run.done);
	}
	/** Frees the job's slot and starts the next queued tasks. */
	#free(job: CodingJob): void {
		this.#running.delete(job.id);
		while (
			!this.#stopped &&
			this.#running.size < this.#maxWorkers &&
			this.#queue.length
		) {
			const next = this.#queue.shift();
			if (next) this.#launch(next);
		}
	}
	async #drop(job: CodingJob): Promise<void> {
		try {
			await this.#options.deliver({
				job,
				outcome: {
					ok: false,
					error:
						"the host stopped before this queued task started; nothing ran, so start it again",
				},
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
	/** Whether the starter's modes may act: only for an owner other than the host's own principal. */
	#modeOf(job: CodingJob): { yolo: boolean; longRunning: boolean } {
		const { modes } = this.#options;
		const speaker = job.starter?.speaker;
		if (
			!modes ||
			!job.starter ||
			speaker?.tier !== "owner" ||
			speaker.principalId === SYSTEM_PRINCIPAL
		)
			return { yolo: false, longRunning: false };
		const mode = modes.peek(job.starter.channel);
		return { yolo: mode.yolo === true, longRunning: mode.longRunning === true };
	}
	/** Whether the starter's yolo mode approves the call now, as it would in that conversation. */
	#yolo(job: CodingJob, call: HeldCall): boolean {
		if (!this.#modeOf(job).yolo || call.approverIds !== undefined) return false;
		const classes = call.holdClasses;
		if (!classes?.length || !classes.every(this.#yoloApproves)) return false;
		const { starter } = job;
		if (!starter) return false;
		try {
			this.#options.modes?.autoApproved?.({
				channel: starter.channel,
				tool: call.tool,
				action: `coding #${job.id} in ${job.repo}: ${call.action}`,
				classes: [...classes],
				principalId: starter.speaker.principalId,
				at: new Date(),
			});
		} catch {
			this.#options.logger.warn(
				{ job: job.id },
				"Recording a yolo approval failed.",
			);
		}
		return true;
	}
	/**
	 * The worker's work-time budget: `timeoutMs`, then, while the starter's long-running mode is
	 * on, further steps up to `autonomy.longRunningMaxMs` in all. Card waits never count.
	 */
	#budget(
		job: CodingJob,
		slot: PromptSlot,
		expire: (workedMs: number) => void,
	): () => void {
		const base = this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		let worked = 0;
		let cancel = () => {};
		const phase = (ms: number) => {
			cancel = workTimeout(ms, slot, () => {
				worked += ms;
				if (this.#modeOf(job).longRunning && worked < this.#longRunningMs)
					phase(Math.min(LONG_RUNNING_STEP_MS, this.#longRunningMs - worked));
				else expire(worked);
			});
		};
		phase(base);
		return () => cancel();
	}
	/** Integrations of one clone run one after another, and never during its report or push. */
	async #integrate(tree: WorkerTree): Promise<Integration> {
		const { repo } = tree;
		const previous = this.#integrations.get(repo) ?? Promise.resolve();
		const mine = previous
			.catch(() => {})
			.then(async () => {
				for (let ship = this.#shipping.get(repo); ship; ) {
					await ship;
					ship = this.#shipping.get(repo);
				}
				this.#integrating.add(repo);
				try {
					return await this.#options.shelf.integrate(tree);
				} finally {
					this.#integrating.delete(repo);
				}
			});
		this.#integrations.set(repo, mine);
		try {
			return await mine;
		} finally {
			if (this.#integrations.get(repo) === mine)
				this.#integrations.delete(repo);
		}
	}
	async #run(job: CodingJob, controller: AbortController): Promise<void> {
		const { shelf, worker, prompts, threads, threadText, deliver } =
			this.#options;
		const slot = promptSlot();
		const held: string[] = [];
		const autoApproved: string[] = [];
		let omittedHeld = 0;
		let omittedApproved = 0;
		const maxReport = this.#options.limits?.reportChars ?? MAX_REPORT_CHARS;
		const maxHeldEntries =
			this.#options.limits?.heldEntries ?? MAX_HELD_ENTRIES;
		const maxHeldChars = this.#options.limits?.heldChars ?? MAX_HELD_CHARS;
		let cancel = () => {};
		let interim: InterimPoster | undefined;
		let timedOut: number | undefined;
		let tree: WorkerTree | undefined;
		let outcome: CodingResult["outcome"];
		try {
			tree = await shelf.addWorktree(job.repo, job.id);
			job.startHead = tree.base.slice(0, 12);
			job.branch = tree.branch;
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
			cancel = this.#budget(job, slot, (worked) => {
				timedOut = worked;
				controller.abort();
			});
			const review = async (call: HeldCall): Promise<HeldCallAnswer> => {
				// The starter's yolo mode answers for a call it may approve, read at the time of the call.
				if (!controller.signal.aborted && this.#yolo(job, call)) {
					if (autoApproved.length < maxHeldEntries)
						autoApproved.push(
							bounded(
								`${call.action}: ${call.tool} ${call.input}`,
								maxHeldChars,
							),
						);
					else omittedApproved++;
					return "approved";
				}
				let answer: HeldCallAnswer = "held";
				try {
					const decision = await slot.prompts?.confirm(
						threadText?.approvalTitle?.(job) ??
							`${slot.asker} requests approval`,
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
				this.#options.logger.warn(
					{ job: job.id, category: error.category, exitCode: error.exitCode },
					"Coding worker failed.",
				);
			}
			if (controller.signal.aborted) message = "the worker was stopped";
			if (timedOut !== undefined)
				message = `the worker ran out of time (${Math.round(timedOut / 60_000)} minutes)`;
			outcome = { ok: false, error: message };
		} finally {
			cancel();
			slot.unbind();
			// What the worker wrote lands before its report.
			await interim?.flush();
		}
		let integration: Integration | undefined;
		if (tree)
			try {
				integration = await this.#integrate(tree);
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
				(integration?.status === "conflict" ||
					integration?.status === "refused")
			) {
				// The work stays on its branch: describe the worktree.
				state = await shelf.treeState(tree);
				commits = await shelf.treeCommits(tree);
			} else {
				state = await shelf.state(job.repo);
				if (integration?.status === "merged") commits = integration.commits;
			}
		} catch {
			this.#options.logger.warn(
				{ job: job.id },
				"Repository state unreadable.",
			);
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
			this.#options.logger.warn({ job: job.id }, "Coding thread close failed.");
		}
		// The work is over: free the slot and the repository before the report turn, so that turn can ship it.
		this.#free(job);
		await deliver(result);
	}
}

/** What became of the worker's branch, for the report. */
export function integrationText(
	integration: Integration | undefined,
	branch: string | undefined,
): string | undefined {
	switch (integration?.status) {
		case "merged":
			return `Merged ${integration.branch}: rebased onto the clone's branch and fast-forwarded it.`;
		case "nothing":
			return `${branch ?? "The worker's branch"} added no commits; its worktree is removed.`;
		case "conflict":
			return `Rebasing ${integration.branch} onto the clone's branch conflicted in:\n${integration.files.join("\n") || "(files not listed)"}\nThe rebase was aborted and the clone is unchanged; the branch ${integration.branch} and its worktree ${integration.dir} are kept to resolve.`;
		case "refused":
			return `Not merged: ${integration.reason}\nThe branch ${integration.branch} and its worktree ${integration.dir} are kept.`;
		default:
			return undefined;
	}
}

export function codingReport(result: CodingResult, started: string): string {
	const { job, outcome, state, commits, held, autoApproved, integration } =
		result;
	const merge = integrationText(integration, job.branch);
	return [
		`## Coding task #${job.id}: ${job.repo}`,
		`Started: ${started}`,
		outcome.ok ? outcome.report : outcome.error,
		"### Held",
		held.length ? held.join("\n") : "None.",
		...(autoApproved?.length
			? ["### Approved by yolo mode", autoApproved.join("\n")]
			: []),
		"### Repository",
		[
			...(merge ? [merge] : []),
			state
				? `Branch ${state.branch}, HEAD ${state.head} (was ${job.startHead}).\nNew commits:\n${commits.join("\n") || "None."}\nUncommitted:\n${state.uncommitted.join("\n") || "None."}`
				: "Unreadable.",
		].join("\n"),
		"Review the changes and checks, then use repo_change_report before repo_push.",
	].join("\n\n");
}
