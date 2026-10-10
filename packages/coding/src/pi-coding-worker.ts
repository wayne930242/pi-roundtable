import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { HeldCall, HoldCheck } from "pi-roundtable";
import { AgentError, canonicalJson, shellHoldRule } from "pi-roundtable/kit";
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
				...(this.#options.scratchDir
					? { env: { ...process.env, TMPDIR: this.#options.scratchDir } }
					: {}),
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
								const action =
									shellHoldRule.describe(tool, input, context) ??
									this.#options.holds?.(tool, input, context);
								if (!signal.aborted) {
									answer = action
										? await review({
												tool,
												input: canonicalJson(input),
												action,
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
