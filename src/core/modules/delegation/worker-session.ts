import { mkdirSync } from "node:fs";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "../../models.ts";
import { runWorkerTask } from "../../runtime/worker-task.ts";
import type { WorkerSessionRequest, WorkerSessions } from "../../services.ts";
import { activeToolsExtension } from "../../shared/active-tools.ts";

export interface WorkerSessionOptions {
	/** Shared with the rest of the host, so the Codex login refreshes in one place. */
	modelRuntime: ModelRuntime;
	agentDir: string;
	workDir: string;
	/** `<provider>/<id>`. */
	model: string;
	thinking: ThinkingLevel;
	prompt: string;
	/** Installed Pi extension packages that register tools. */
	extensionPaths?: readonly string[];
	/** Extensions that register tools. */
	extensions?: readonly { name: string; factory: ExtensionFactory }[];
	/** The only tools active in the session; no built-in tool is. */
	toolNames: readonly string[];
	task: string;
	signal: AbortSignal;
	aborted: string;
}

/**
 * Runs one task in a fresh, unsaved session with no built-in tool, no skills, no context files and
 * only the named tools active, and returns the worker's report.
 */
export async function runWorkerSession(
	options: WorkerSessionOptions,
): Promise<string> {
	const { modelRuntime, agentDir, workDir, model, thinking } = options;
	mkdirSync(workDir, { recursive: true });
	const resourceLoader = new DefaultResourceLoader({
		cwd: workDir,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalExtensionPaths: [...(options.extensionPaths ?? [])],
		extensionFactories: [
			...(options.extensions ?? []),
			// Last, so it undoes any tool another extension re-activates.
			{
				name: "worker-tools-only",
				factory: activeToolsExtension(() => options.toolNames),
			},
		],
		appendSystemPrompt: [options.prompt],
	});
	await resourceLoader.reload();
	options.signal.throwIfAborted();
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
		model,
		task: options.task,
		signal: options.signal,
		aborted: options.aborted,
	});
}

/** The `WORKER_SESSIONS` service: worker sessions on the host's model runtime and delegation settings. */
export function workerSessions(options: {
	modelRuntime: ModelRuntime;
	agentDir: string;
	workDir: string;
	delegation: { model: string; thinking: ThinkingLevel };
}): WorkerSessions {
	return {
		delegation: options.delegation,
		run: (request: WorkerSessionRequest) =>
			runWorkerSession({
				modelRuntime: options.modelRuntime,
				agentDir: options.agentDir,
				workDir: options.workDir,
				model: request.model ?? options.delegation.model,
				thinking: request.thinking ?? options.delegation.thinking,
				prompt: request.prompt,
				extensions: request.extensions.map((factory, index) => ({
					name: `worker-tools-${index}`,
					factory,
				})),
				toolNames: request.toolNames,
				task: request.task,
				signal: request.signal,
				aborted: request.aborted ?? "the worker ran out of time",
			}),
	};
}
