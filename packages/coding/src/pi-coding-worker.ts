import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { HeldCall, HoldCheck, ShellEnv } from "pi-roundtable";
import {
	AgentError,
	canonicalJson,
	childEnv,
	holdChain,
	shellHoldRule,
} from "pi-roundtable/kit";
import type {
	CodingJob,
	CodingProgress,
	CodingWorker,
	HeldCallAnswer,
} from "./coding-desk.ts";
import { CodingWorkerFailure } from "./worker-failure.ts";

export interface PiCodingWorkerOptions {
	/** Installed Pi extension package paths; their extra tools stay inactive. */
	packages?: string[];
	/** Pi credentials and models live here, defaulting to Pi's host login directory. */
	agentDir?: string;
	/** Additional host rules, consulted in the parent process. */
	holds?: HoldCheck;
	/** Trusted host policy boundary for writes; defaults to the individual clone. */
	workspace?: string;
	/**
	 * The host's scratch dir: the worker's shell runs with TMPDIR pointing to it, and writes and
	 * removals inside it run without a hold, as in the agents' shell.
	 */
	scratchDir?: string;
	/** Trusted host standing prompt, replacing the generic worker instructions. */
	prompt?: (dir: string) => string;
	/**
	 * Trusted wording of what the worker reads when a call is not approved, given what the call
	 * would do. Default: the owner declined or has not approved it; list it under Held in the report.
	 */
	blockText?: (answer: "declined" | "held", action: string) => string;
	/** Longest worker error text kept for the report, in characters; default 600. */
	diagnosticChars?: number;
	/**
	 * Host variables the worker process gets besides `SHELL_ENV_NAMES`, `PI_CODING_AGENT_DIR` and
	 * `modelEnvNames` (its `models.json` `$VAR`s, `CLAUDE_*`, `ANTHROPIC_*`), for a model reading
	 * another name. Its shell never gets them.
	 */
	workerEnv?: WorkerEnv;
	/** What the worker's shell gets besides `SHELL_ENV_NAMES`, as the agents' shell; default the host's `env.shellEnv`. */
	shellEnv?: ShellEnv;
}

/** Host variables a coding worker's process gets for its model and Pi runtime, by name. */
export interface WorkerEnv {
	pass?: readonly string[];
}

/**
 * The host variables a worker's model may read, found without the host listing them: the names a
 * `models.json` in Pi's agent dir writes as `$NAME` (an API key a custom provider resolves), and
 * the Claude Code and Anthropic families (`CLAUDE_*`, `ANTHROPIC_*`) that Anthropic providers and
 * Claude Code bridges read. A missing or unreadable `models.json` adds nothing.
 */
export function modelEnvNames(agentDir: string): string[] {
	const names = ["CLAUDE_*", "ANTHROPIC_*"];
	try {
		const text = readFileSync(join(agentDir, "models.json"), "utf8");
		for (const match of text.matchAll(/"\$([A-Za-z_][A-Za-z0-9_]*)"/g))
			if (match[1] && !names.includes(match[1])) names.push(match[1]);
	} catch {
		// No models.json: the providers' own variables above are all.
	}
	return names;
}

/**
 * The worker process's environment: the shell's whitelist, Pi's agent dir, the variables its model
 * may read (`modelEnvNames`), `workerEnv.pass`, and TMPDIR. Its bash cuts this again to the shell's.
 */
export function workerProcessEnv(
	source: Readonly<Record<string, string | undefined>>,
	workerEnv: WorkerEnv = {},
	scratchDir?: string,
	agentDir: string = getAgentDir(),
): Record<string, string> {
	return childEnv(source, {
		pass: [
			"PI_CODING_AGENT_DIR",
			...modelEnvNames(agentDir),
			...(workerEnv.pass ?? []),
		],
		...(scratchDir ? { set: { TMPDIR: scratchDir } } : {}),
	});
}
interface WorkerMessage {
	type: string;
	id?: number;
	tool?: string;
	input?: Record<string, unknown>;
	report?: string;
	message?: string;
	role?: string;
	stopReason?: string;
	text?: string;
	name?: string;
}
function isMessage(value: unknown): value is WorkerMessage {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		typeof value.type === "string"
	);
}

/** The worker's own shell rule as a check, for the classes of the calls it holds. */
const SHELL_CHECK: HoldCheck = holdChain([shellHoldRule]);

/**
 * The hold classes of a held call, from every check that held it, as the host's gate records them
 * for yolo mode; undefined when a holding check tells none, which leaves the call unclassed.
 */
function classesOf(
	tool: string,
	input: Record<string, unknown>,
	context: { workspace: string; scratchDir?: string },
	holding: readonly HoldCheck[],
): string[] | undefined {
	const found: string[] = [];
	for (const check of holding) {
		const classes = check.classesOf?.(tool, input, context);
		if (!classes?.length) return undefined;
		found.push(...classes);
	}
	return found.length ? [...new Set(found)] : undefined;
}

/** A fresh Bun process per task; only the host decides whether a held call may run. */
export class PiCodingWorker implements CodingWorker {
	readonly #options: PiCodingWorkerOptions;
	constructor(options: PiCodingWorkerOptions = {}) {
		this.#options = options;
	}
	async run(
		job: CodingJob & { dir: string },
		signal: AbortSignal,
		review: (call: HeldCall) => Promise<HeldCallAnswer>,
		progress?: CodingProgress,
	): Promise<string> {
		if (process.platform === "win32")
			throw new AgentError("Coding workers require a POSIX host.");
		if (signal.aborted) throw new AgentError("the worker was stopped");
		const prompt = this.#options.prompt?.(job.dir);
		let report: string | undefined;
		let failure: string | undefined;
		const child = Bun.spawn(
			[
				process.execPath,
				fileURLToPath(new URL("./worker-entry.ts", import.meta.url)),
			],
			{
				cwd: job.dir,
				env: workerProcessEnv(
					process.env,
					this.#options.workerEnv,
					this.#options.scratchDir,
					this.#options.agentDir ?? getAgentDir(),
				),
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
				detached: true,
				ipc: (value, proc) => {
					if (!isMessage(value)) return;
					if (value.type === "ready") {
						proc.send({
							type: "start",
							// Thread handles and their host callbacks never cross IPC.
							job: { ...job, thread: undefined },
							packages: this.#options.packages ?? [],
							agentDir: this.#options.agentDir ?? getAgentDir(),
							prompt,
							progress: progress !== undefined,
							...(this.#options.scratchDir
								? { scratchDir: this.#options.scratchDir }
								: {}),
							...(this.#options.shellEnv
								? { shellEnv: this.#options.shellEnv }
								: {}),
						});
					} else if (
						value.type === "report" &&
						typeof value.report === "string"
					) {
						report = value.report;
					} else if (
						value.type === "message" &&
						typeof value.role === "string" &&
						typeof value.text === "string"
					) {
						progress?.messageEnd({
							role: value.role,
							content: value.text,
							...(typeof value.stopReason === "string"
								? { stopReason: value.stopReason }
								: {}),
						});
					} else if (value.type === "tool" && typeof value.name === "string") {
						progress?.toolStart(value.name);
					} else if (
						value.type === "failure" &&
						typeof value.message === "string"
					) {
						failure = value.message.slice(
							0,
							this.#options.diagnosticChars === undefined
								? 2_000
								: this.#options.diagnosticChars * 4,
						);
					} else if (
						value.type === "call" &&
						Number.isSafeInteger(value.id) &&
						typeof value.tool === "string" &&
						typeof value.input === "object" &&
						value.input !== null
					) {
						const { id, tool, input } = value;
						void (async () => {
							let answer: HeldCallAnswer = "held";
							let reason: string | undefined;
							try {
								const context = {
									workspace: this.#options.workspace ?? job.dir,
									...(this.#options.scratchDir
										? { scratchDir: this.#options.scratchDir }
										: {}),
								};
								// Every check is asked once, so the classes cover each reason the call is held.
								const shell = shellHoldRule.describe(tool, input, context);
								const { holds } = this.#options;
								const host = holds?.(tool, input, context);
								const action = shell ?? host;
								if (!signal.aborted) {
									const holdClasses = action
										? classesOf(tool, input, context, [
												...(shell === undefined ? [] : [SHELL_CHECK]),
												...(host === undefined || !holds ? [] : [holds]),
											])
										: undefined;
									answer = action
										? await review({
												tool,
												input: canonicalJson(input),
												action,
												...(holdClasses ? { holdClasses } : {}),
											})
										: "approved";
									if (action && answer !== "approved")
										reason = this.#options.blockText?.(answer, action);
								}
							} catch {
								/* Fail closed. */
							}
							if (!signal.aborted && child.exitCode === null)
								proc.send({
									type: "answer",
									id,
									answer,
									...(reason ? { reason } : {}),
								});
						})();
					}
				},
			},
		);
		const kill = () => {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				/* The group has already exited. */
			}
		};
		signal.addEventListener("abort", kill, { once: true });
		try {
			if (signal.aborted) kill();
			const code = await child.exited;
			if (signal.aborted) throw new CodingWorkerFailure("stopped");
			if (code !== 0)
				throw new CodingWorkerFailure(
					"exit",
					code,
					failure,
					this.#options.diagnosticChars,
				);
			if (!report?.trim()) throw new CodingWorkerFailure("missing-report");
			return report;
		} finally {
			signal.removeEventListener("abort", kill);
			kill(); // Also remove shell descendants the task left running.
		}
	}
}
