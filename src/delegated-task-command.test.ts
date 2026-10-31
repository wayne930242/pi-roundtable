import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { definePlugin } from "./core/define.ts";
import { PiAgentRuntime } from "./core/runtime/pi-agent-runtime.ts";
import { OWNER_SPEAKER, testPlugin } from "./testing.ts";

/** Every string in a value, in order. */
function textOf(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(textOf);
	if (value && typeof value === "object")
		return Object.values(value).flatMap(textOf);
	return [];
}

const TASK = "/delegated-task-danger run now";

test("a delegated task's text reaches the worker's model as text and never runs an extension command", async () => {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-task-command-"));
	const core = createFauxCore({ provider: "faux", models: [{ id: "faux-1" }] });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	modelRuntime.registerProvider("faux", {
		api: core.api,
		apiKey: "test",
		baseUrl: "http://faux.invalid",
		streamSimple: core.streamSimple,
		models: [
			{
				id: "faux-1",
				name: "Faux",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 1_000,
			},
		],
	});
	const ran: string[] = [];
	const requests: string[] = [];
	const harness = await testPlugin(
		definePlugin({
			name: "task-command",
			providers: {
				runtime: (deps) =>
					new PiAgentRuntime({
						owner: {
							...deps.owner,
							pronouns: {
								subject: "they",
								object: "them",
								possessive: "their",
							},
						},
						agentDir: dir,
						dataDir: dir,
						modelRuntime,
						model: { provider: "faux", id: "faux-1" },
						thinking: "off",
						effort: { judge: async () => "off" },
						sessions: deps.sessions,
						logger: deps.logger,
						confirmations: deps.confirmations,
						prompts: deps.prompts,
					}),
			},
			setup: () => ({
				personas: [{ kind: "owner", prompt: () => "You are the persona." }],
				sessionTools: [
					{
						name: "probe",
						phase: "tools",
						snapshot: () => ({
							revision: 0,
							factory: (session) => (pi) => {
								pi.registerCommand("delegated-task-danger", {
									description: "A command a task must never reach",
									handler: async (args) => {
										ran.push(args);
									},
								});
								pi.registerTool({
									name: "probe_task",
									label: "probe_task",
									description: "Run a task beside this conversation.",
									parameters: Type.Object({}),
									execute: async () => {
										const report = await session.runTask({
											selection: { tools: [], groups: [] },
											text: TASK,
											timeoutMs: 10_000,
											exclude: [],
										});
										return {
											content: [{ type: "text", text: report }],
											details: undefined,
										};
									},
								});
							},
						}),
					},
					{
						name: "compactor",
						phase: "tools",
						snapshot: () => ({
							revision: 0,
							factory: () => (pi) => {
								pi.registerTool({
									name: "compact_session",
									label: "compact_session",
									description: "Test compactor registration.",
									parameters: Type.Object({}),
									execute: async () => {
										throw new Error("not scripted");
									},
								});
							},
						}),
					},
				],
			}),
		}),
	);
	try {
		const record =
			(reply: ReturnType<typeof fauxAssistantMessage>) =>
			(context: TranscriptContext) => {
				requests.push(textOf(context.messages).join("\n"));
				return reply;
			};
		core.appendResponses([
			record(
				fauxAssistantMessage([fauxToolCall("probe_task", {})], {
					stopReason: "toolUse",
				}),
			),
			record(fauxAssistantMessage([fauxText("The report.")])),
			record(fauxAssistantMessage([fauxText("Done.")])),
		]);
		const result = await harness.turns.run({
			channel: "task-command:room",
			kind: "owner",
			text: "hello",
			speaker: OWNER_SPEAKER,
			selection: { id: "task-command", tools: ["probe_task"], groups: [] },
		});
		expect(result.ok).toBe(true);
		expect(ran).toEqual([]);
		// The worker's request is the second one, and it carries the task as plain text.
		expect(requests[1]).toContain(TASK);
	} finally {
		await harness.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});
