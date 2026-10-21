import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PluginError } from "../../errors.ts";
import {
	formatModelRef,
	type ModelRef,
	type ThinkingLevel,
} from "../../models.ts";
import { packageDir } from "../../shared/package-dir.ts";
import { runWorkerSession } from "./worker-session.ts";

const WEB_TOOLS = ["web_search", "fetch_content", "get_search_content"];

const WORKER_PROMPT =
	"You are a research worker. Another agent handed you the task below and will pass your report on. Do it with web search and page reading, preferring primary sources. Report in the task's language, self-contained, with a source link for each claim, and say what you could not verify.";

/** The folder of `pi-web-access`, a peer dependency the host installs, or a PluginError that says how. */
function webAccessDir(): string {
	try {
		return packageDir("pi-web-access");
	} catch (error) {
		throw new PluginError(
			"the delegation worker loads pi-web-access, which this project does not have installed. It is a peer dependency of pi-roundtable: run `bun add pi-web-access@0.40.0` (or your own build of it, which the worker then uses too).",
			{ cause: error },
		);
	}
}

export interface WebResearchWorkerOptions {
	/** Shared with the rest of the host, so the Codex login refreshes in one place. */
	modelRuntime: ModelRuntime;
	agentDir: string;
	workDir: string;
	model: ModelRef;
	thinking: ThinkingLevel;
}

/** Runs one task in a fresh, unsaved session that can only search and read the web. */
export class WebResearchWorker {
	readonly #options: WebResearchWorkerOptions;
	readonly #webAccessPath: string;

	constructor(options: WebResearchWorkerOptions) {
		this.#options = options;
		this.#webAccessPath = webAccessDir();
	}

	run(task: string, signal: AbortSignal): Promise<string> {
		const { modelRuntime, agentDir, workDir, model, thinking } = this.#options;
		return runWorkerSession({
			modelRuntime,
			agentDir,
			workDir,
			model: formatModelRef(model),
			thinking,
			prompt: WORKER_PROMPT,
			extensionPaths: [this.#webAccessPath],
			toolNames: WEB_TOOLS,
			task,
			signal,
			aborted: "the worker ran out of time",
		});
	}
}
