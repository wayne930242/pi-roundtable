import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { HeldCall, HoldCheck } from "pi-roundtable";
import { AgentError, canonicalJson, shellHoldRule } from "pi-roundtable/kit";
import type { CodingJob, CodingWorker, HeldCallAnswer } from "./coding-desk.ts";
import { CodingWorkerFailure } from "./worker-failure.ts";

export interface PiCodingWorkerOptions {
	/** Installed Pi extension package paths; their extra tools stay inactive. */
	packages?: string[];
	/** Pi credentials and models live here, defaulting to Pi's host login directory. */
	agentDir?: string;
	/** Additional host rules, consulted in the parent process. */
	holds?: HoldCheck;
}
interface WorkerMessage {
	type: string;
	id?: number;
	tool?: string;
	input?: Record<string, unknown>;
	report?: string;
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
	): Promise<string> {
		if (process.platform === "win32")
			throw new AgentError("Coding workers require a POSIX host.");
		if (signal.aborted) throw new AgentError("The worker was stopped.");
		let report: string | undefined;
		const child = Bun.spawn(
			[
				process.execPath,
				fileURLToPath(new URL("./worker-entry.ts", import.meta.url)),
			],
			{
				cwd: job.dir,
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
				detached: true,
				ipc: (value, proc) => {
					if (!isMessage(value)) return;
					if (value.type === "ready") {
						proc.send({
							type: "start",
							job,
							packages: this.#options.packages ?? [],
							agentDir: this.#options.agentDir ?? getAgentDir(),
						});
					} else if (
						value.type === "report" &&
						typeof value.report === "string"
					) {
						report = value.report;
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
							try {
								const context = { workspace: job.dir };
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
								}
							} catch {
								/* Fail closed. */
							}
							if (!signal.aborted && child.exitCode === null)
								proc.send({ type: "answer", id, answer });
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
			if (code !== 0) throw new CodingWorkerFailure("exit", code);
			if (!report?.trim()) throw new CodingWorkerFailure("missing-report");
			return report;
		} finally {
			signal.removeEventListener("abort", kill);
			kill(); // Also remove shell descendants the task left running.
		}
	}
}
