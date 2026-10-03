import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	activeToolsExtension,
	runWorkerTask,
	SHELL_TOOLS,
} from "pi-roundtable/kit";
import type { CodingJob, HeldCallAnswer } from "./coding-desk.ts";

interface StartMessage {
	type: "start";
	job: CodingJob & { dir: string };
	packages: string[];
	agentDir: string;
	prompt?: string;
}
export function codingWorkerPrompt(dir: string): string {
	return [
		`You are a coding worker in ${dir}. The next message is your approved task. Read this repository's AGENTS.md.`,
		"Work with the shell and file tools available. Complete and verify the contract, stage files by name and commit using repository conventions, without tool attribution.",
		"Do not push or ship. The calling agent reviews your commits and requests the owner's approval through repo_change_report and repo_push.",
		"Risky calls wait for the owner's approval. An approved call runs; a declined or held call must not be retried or worked around.",
		"Resolve decisions settled by the task or repository. Put remaining owner decisions and held actions in your report instead of guessing.",
		"Report changes and reasons, commits, checks and outcomes, held actions, and remaining work.",
	].join("\n\n");
}
const answers = new Map<
	number,
	(answer: HeldCallAnswer, reason?: string) => void
>();
let nextId = 1;
let started = false;
async function run({
	job,
	agentDir,
	packages,
	prompt,
}: StartMessage): Promise<string> {
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const loader = new DefaultResourceLoader({
		cwd: job.dir,
		agentDir,
		noExtensions: true,
		additionalExtensionPaths: packages,
		noSkills: true,
		additionalSkillPaths: job.skillFiles,
		noPromptTemplates: true,
		noThemes: true,
		agentsFilesOverride: ({ agentsFiles }) => ({
			agentsFiles: agentsFiles.filter((file) => {
				try {
					if (!lstatSync(file.path).isFile()) return false;
					const path = relative(realpathSync(job.dir), realpathSync(file.path));
					return !path.startsWith("..") && !isAbsolute(path);
				} catch {
					return false;
				}
			}),
		}),
		extensionFactories: [
			{
				name: "coding-shell",
				factory: activeToolsExtension(() => SHELL_TOOLS),
			},
			{
				name: "coding-approvals",
				factory: (pi) => {
					pi.on("tool_call", async (event) => {
						const id = nextId++;
						const { answer, reason } = await new Promise<{
							answer: HeldCallAnswer;
							reason?: string | undefined;
						}>((resolve) => {
							answers.set(id, (answer, reason) => resolve({ answer, reason }));
							process.send?.({
								type: "call",
								id,
								tool: event.toolName,
								input: event.input,
							});
						});
						if (answer !== "approved")
							return {
								block: true,
								reason:
									reason ??
									`The owner ${answer === "declined" ? "declined" : "has not approved"} this call. Do not retry it or work around it; list it under Held in your report.`,
							};
						return undefined;
					});
				},
			},
		],
		appendSystemPrompt: [prompt ?? codingWorkerPrompt(job.dir)],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: job.dir,
		agentDir,
		modelRuntime,
		thinkingLevel: job.thinking,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(job.dir),
		settingsManager: SettingsManager.inMemory({}),
	});
	return runWorkerTask(session, {
		modelRuntime,
		model: job.model,
		task: job.task,
		signal: new AbortController().signal,
		aborted: "the worker was stopped",
	});
}
if (process.send) {
	process.on("message", (message: unknown) => {
		if (typeof message !== "object" || message === null || !("type" in message))
			return;
		if (
			message.type === "answer" &&
			"id" in message &&
			typeof message.id === "number" &&
			"answer" in message &&
			(message.answer === "approved" ||
				message.answer === "declined" ||
				message.answer === "held")
		) {
			answers.get(message.id)?.(
				message.answer,
				"reason" in message && typeof message.reason === "string"
					? message.reason
					: undefined,
			);
			answers.delete(message.id);
		} else if (message.type === "start" && !started) {
			started = true;
			void run(message as StartMessage).then(
				(report) => {
					process.send?.({ type: "report", report }, () => process.exit(0));
				},
				(error: unknown) =>
					process.send?.(
						{
							type: "failure",
							message: error instanceof Error ? error.message : String(error),
						},
						() => process.exit(1),
					),
			);
		}
	});
	process.send({ type: "ready" });
}
