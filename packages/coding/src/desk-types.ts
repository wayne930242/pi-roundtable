import type {
	ChannelKey,
	ConversationModes,
	HeldCall,
	InterimTextMode,
	Logger,
	OwnerPrompts,
	ThinkingLevel,
	Tier,
} from "pi-roundtable";
import type { DispatchThread, DispatchThreads } from "pi-roundtable/kit";
import type { Integration, RepoShelf, RepoState } from "./repo-shelf.ts";

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
	/** The agent whose turn started it, which may list and cancel it. */
	agent?: string;
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
