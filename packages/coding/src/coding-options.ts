import type {
	ChannelKey,
	HoldCheck,
	InterimTextMode,
	ThinkingLevel,
	ToolTurn,
} from "pi-roundtable";
import type { DispatchThreads } from "pi-roundtable/kit";
import type {
	CodingAutonomy,
	CodingJob,
	CodingLimits,
	CodingModes,
	CodingResult,
	CodingThreadText,
	CodingWorker,
} from "./coding-desk.ts";
import type { WorkerEnv } from "./pi-coding-worker.ts";
import type {
	ChangeReport,
	CloneCommand,
	GithubToken,
	RepoSummary,
} from "./repo-shelf.ts";

export interface CodingRun {
	model: string;
	thinking: ThinkingLevel;
	channel: ChannelKey;
	origin?: ChannelKey;
}
export type RepoToolName =
	| "repo_list"
	| "repo_add"
	| "repo_change_report"
	| "repo_push"
	| "repo_task";
/** Trusted wording of one repository tool, as the model reads it; unset fields keep the defaults. */
export interface CodingToolText {
	description?: string;
	/** Argument descriptions by argument name. */
	parameters?: Record<string, string>;
}
export interface CodingPresentation {
	/** The repo_list result; unset: the managed clones as JSON. */
	list?(
		repos: (RepoSummary & { skills: string[] })[],
		context: { shelfDir: string; fetched: boolean },
	): string;
	/** Separate the owner's posted record from the model's shipping instructions. */
	changeReport?(
		report: ChangeReport,
		direct: boolean,
	): { post: string; result: string };
	taskStarted?(job: CodingJob, skippedSkills: string[]): string;
	/** The repo_task result for a task waiting for a worker slot, at `position` (from 1) in the queue. */
	/**
	 * Wording of the Settings page, keyed by its English text, such as
	 * `{ "Coding workers": "..." }`; it wins over the built-in zh-TW wording, key by key.
	 */
	messages?: Readonly<Record<string, string>>;
	taskQueued?(
		job: CodingJob,
		position: number,
		skippedSkills: string[],
	): string;
}
export interface CodingOptions {
	shelfDir: string;
	/** Provider/model-id, resolved with the worker's Pi host login. */
	model: string;
	thinking?: ThinkingLevel;
	/** Exact owner/repo names allowed to use repo_push without a hold. Default: none. */
	ownerRepos?: string[];
	/** Trusted host policy for additional owner-owned repositories, including future clones.
	 * Only literal true grants an exemption. This never bypasses linked host hold rules. */
	isOwnerRepo?: (repo: string) => boolean;
	/** Trusted wording for the approval card of a held `repo_push`. Default: names the repository, sha, target and branch. */
	pushHoldText?: (repo: string, sha: string) => string;
	/** Moves legacy standalone clones before the host reads shelf-linked skills. */
	adoptClones?: { from: string; repo: string }[];
	/** Resolve the calling agent/owner's run identity, independently of report posting. */
	resolveRun?: (turn: ToolTurn) => CodingRun | Promise<CodingRun>;
	/** Post change reports in the caller's identity/channel rather than the default surface. */
	postChangeReport?: (turn: ToolTurn, text: string) => Promise<void>;
	presentation?: CodingPresentation;
	/** Trusted wording of the repository tools' descriptions and arguments. */
	toolText?: Partial<Record<RepoToolName, CodingToolText>>;
	threads?: Pick<DispatchThreads, "open">;
	threadText?: CodingThreadText;
	/**
	 * Whether a worker posts its progress into its thread as it goes: longer text as messages, short
	 * narration and its tools in one edited small-text message. Default "on"; "off" posts only the
	 * task and the report. Pass the host config's `interimText` to follow it.
	 */
	interimText?: InterimTextMode;
	/** Length from which a worker's intermediate text is its own message; default 400. */
	interimPrimaryChars?: number;
	workerWorkspace?: string;
	workerPrompt?: (dir: string) => string;
	/** How much of a long run a report keeps; see `CodingLimits`. */
	limits?: CodingLimits;
	/** Longest git, gh and worker error text kept in a failure, in characters; default 600. */
	diagnosticChars?: number;
	/** Trusted wording of what the worker reads when a call is declined or held; see `PiCodingWorkerOptions.blockText`. */
	workerBlockText?: (answer: "declined" | "held", action: string) => string;
	/** Opt in to skipping unavailable implicit skills; explicit requests always fail closed. */
	skipUnavailableCarriedSkills?: boolean;
	/** Absolute installed extension package paths. Default: none. */
	workerPackages?: string[];
	agentDir?: string;
	/**
	 * More host variables the worker process gets for its model, by name; its shell never gets them.
	 * Without it the worker already gets the shell's whitelist, `PI_CODING_AGENT_DIR`, the `$VAR`s
	 * its agent dir's `models.json` names, and `CLAUDE_*` and `ANTHROPIC_*`.
	 */
	workerEnv?: WorkerEnv;
	/**
	 * The token git and gh calls of the shelf (clone, fetch, push) get as GH_TOKEN, or a function
	 * read at each call; no other host secret reaches them. Default: the host's GH_TOKEN, read when
	 * the plugin sets up.
	 */
	githubToken?: GithubToken;
	timeoutMs?: number;
	/** Workers running at once on the host, 1 to 64; default 4. More tasks wait in a queue. */
	maxWorkers?: number;
	/**
	 * Keep the owner's worker limit, set on the web app's Settings page, in the host database
	 * (table `coding_settings`), where it wins over `maxWorkers` at the next start; needs a
	 * database. Default false: a change lasts until the host stops.
	 */
	settingsInDatabase?: boolean;
	/** Tasks waiting for a worker slot, first in first out; one more is refused. Default 16. */
	maxQueued?: number;
	/**
	 * The conversations' modes, such as `context.services.find(MODES)`: a worker then follows the
	 * yolo and long-running modes of the conversation whose owner turn started it, read live.
	 * Without them a worker asks a card for every held call and stops at `timeoutMs`.
	 */
	modes?: CodingModes;
	/** The host's resolved `autonomy` limits, which the worker's yolo and long-running modes follow. */
	autonomy?: CodingAutonomy;
	/** Optional additional worker rules; linked host rules also apply. */
	holds?: HoldCheck;
	/** A different Git host or an offline clone implementation. */
	clone?: CloneCommand;
	/** Replace the process runner for deterministic tests. */
	worker?: CodingWorker;
	/** Override report delivery, for example to schedule a background conversation turn. */
	onResult?: (result: CodingResult) => Promise<void>;
}
