import { mkdirSync } from "node:fs";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { PluginError } from "../../errors.ts";
import {
	formatModelRef,
	type ModelRef,
	type ThinkingLevel,
} from "../../models.ts";
import { runWorkerTask } from "../../runtime/worker-task.ts";
import { activeToolsExtension } from "../../shared/active-tools.ts";
import { packageDir } from "../../shared/package-dir.ts";

const WEB_TOOLS = ["web_search", "fetch_content", "get_search_content"];

const WORKER_PROMPT =
	"You are a research worker. Another agent handed you the task below and will pass your report on. Do it with web search and page reading, preferring primary sources. Report in the task's language, self-contained, with a source link for each claim, and say what you could not verify.";

/** The folder of `pi-web-access`, a peer dependency the host installs, or a PluginError that says how. */
function webAccessDir(): string {
	try {
		return packageDir("pi-web-access");
	} catch (error) {
		throw new PluginError(
			"the delegation worker loads pi-web-access, which this project does not have installed. It is a peer dependency of pi-roundtable: run `bun add pi-web-access@0.35.0` (or your own build of it, which the worker then uses too).",
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
		mkdirSync(options.workDir, { recursive: true });
	}

	async run(task: string, signal: AbortSignal): Promise<string> {
		const { modelRuntime, agentDir, workDir, model, thinking } = this.#options;
		const resourceLoader = new DefaultResourceLoader({
			cwd: workDir,
			agentDir,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: [this.#webAccessPath],
			extensionFactories: [
				{ name: "web-only", factory: activeToolsExtension(() => WEB_TOOLS) },
			],
			appendSystemPrompt: [WORKER_PROMPT],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: workDir,
			agentDir,
			thinkingLevel: thinking,
			modelRuntime,
			resourceLoader,
			sessionManager: SessionManager.inMemory(workDir),
			settingsManager: SettingsManager.inMemory({}),
			noTools: "builtin",
		});
		return runWorkerTask(session, {
			modelRuntime,
			model: formatModelRef(model),
			task,
			signal,
			aborted: "the worker ran out of time",
		});
	}
}
