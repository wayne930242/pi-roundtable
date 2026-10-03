import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	activeToolsExtension,
	runWorkerTask,
	toolText,
} from "pi-roundtable/kit";
import { type SafeFetchResult, safeFetch } from "./safe-fetch.ts";

export interface SandboxResearchOptions {
	modelRuntime: ModelRuntime;
	agentDir: string;
	workDir: string;
	model: string;
	thinking: "low" | "medium" | "high" | "xhigh";
	search(query: string, signal: AbortSignal): Promise<string>;
	/** Parse only these already-bounded fetched bytes; never re-fetch the URL. */
	extractFetched?(
		result: SafeFetchResult,
		signal: AbortSignal,
	): Promise<string>;
	/**
	 * A host-owned fetch-and-extract for a model-supplied URL, replacing the built-in bounded fetch
	 * plus `extractFetched`. The host is then responsible for refusing unsafe and private addresses
	 * (see `assertPublicUrl` and `safeFetch`) and for bounding time and size.
	 */
	fetchContent?(url: string, signal: AbortSignal): Promise<string>;
}
/** Host subscription research with no built-in tools, host memory, discovery, or shell. */
export class SandboxResearchWorker {
	constructor(readonly options: SandboxResearchOptions) {
		if (!options.fetchContent && !options.extractFetched)
			throw new Error("Research needs fetchContent or extractFetched");
	}
	async run(task: string, signal: AbortSignal): Promise<string> {
		signal.throwIfAborted();
		const {
			createAgentSession,
			DefaultResourceLoader,
			SessionManager,
			SettingsManager,
		} = await import("@earendil-works/pi-coding-agent");
		const { Type } = await import("typebox");
		const options = this.options;
		const loader = new DefaultResourceLoader({
			cwd: options.workDir,
			agentDir: options.agentDir,
			// Nothing from the host's settings or a global SYSTEM.md may reach a guest-triggered session.
			settingsManager: SettingsManager.inMemory({}),
			systemPromptOverride: () => undefined,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [
				{
					name: "research-tools",
					factory: (pi) => {
						pi.registerTool({
							name: "web_search",
							label: "Search",
							description: "Search public sources and return a sourced answer.",
							parameters: Type.Object({
								query: Type.String({ minLength: 1, maxLength: 4000 }),
							}),
							execute: async (_id, input, callSignal) =>
								toolText(
									await options.search(
										input.query,
										AbortSignal.any([
											signal,
											...(callSignal ? [callSignal] : []),
										]),
									),
								),
						});
						pi.registerTool({
							name: "fetch_content",
							label: "Fetch page",
							description:
								"Read a public HTTP(S) page. Private addresses are refused.",
							parameters: Type.Object({
								url: Type.String({ maxLength: 8000 }),
							}),
							execute: async (_id, input, callSignal) => {
								const bound = AbortSignal.any([
									signal,
									...(callSignal ? [callSignal] : []),
								]);
								if (options.fetchContent)
									return toolText(await options.fetchContent(input.url, bound));
								return toolText(
									await (
										options.extractFetched as NonNullable<
											typeof options.extractFetched
										>
									)(await safeFetch(input.url, { signal: bound }), bound),
								);
							},
						});
					},
				},
				{
					name: "research-only",
					factory: activeToolsExtension(() => ["web_search", "fetch_content"]),
				},
			],
			appendSystemPrompt: [
				"You are a research worker. Research the task using public sources. Report in the task's language, self-contained, with source links; state what could not be verified. You have no host shell, owner data, memory, or agent tools.",
			],
		});
		await loader.reload();
		signal.throwIfAborted();
		const { session } = await createAgentSession({
			cwd: options.workDir,
			agentDir: options.agentDir,
			modelRuntime: options.modelRuntime,
			resourceLoader: loader,
			thinkingLevel: options.thinking,
			sessionManager: SessionManager.inMemory(options.workDir),
			settingsManager: SettingsManager.inMemory({}),
			noTools: "builtin",
		});
		return runWorkerTask(session, {
			modelRuntime: options.modelRuntime,
			model: options.model,
			task,
			signal,
			aborted: "Research deadline exceeded",
		});
	}
}
