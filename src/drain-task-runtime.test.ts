import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { definePlugin } from "./core/plugin-api/define.ts";
import { PiAgentRuntime } from "./core/runtime/pi-agent-runtime.ts";
import { OWNER_SPEAKER, testPlugin } from "./testing.ts";

/**
 * A real Pi turn that calls a tool which runs a transient task, on a host that is draining while
 * its `stopping` reads false: inside the delivery of a report `finishing` masks `closed`, so the
 * report's own turn can run.
 */
test("a report turn during the drain runs, and the task it spawns is refused", async () => {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-drain-task-"));
	const core = createFauxCore({ provider: "faux", models: [{ id: "faux-1" }] });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	let requests = 0;
	modelRuntime.registerProvider("faux", {
		api: core.api,
		apiKey: "test",
		baseUrl: "http://faux.invalid",
		streamSimple: (model, context, options) => {
			requests += 1;
			return core.streamSimple(model, context, options);
		},
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
	const spawned: string[] = [];
	const harness = await testPlugin(
		definePlugin({
			name: "drain-task",
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
						stopping: () => false,
						draining: () => true,
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
								pi.registerTool({
									name: "probe_task",
									label: "probe_task",
									description: "Run a task beside this conversation.",
									parameters: Type.Object({}),
									execute: async () => {
										const report = await session
											.runTask({
												selection: { tools: [], groups: [] },
												text: "a task",
												timeoutMs: 10_000,
												exclude: [],
											})
											.catch((error: unknown) => {
												spawned.push(
													error instanceof Error
														? error.message
														: String(error),
												);
												return "refused";
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
		core.appendResponses([
			fauxAssistantMessage([fauxToolCall("probe_task", {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("Done.")]),
		]);
		const result = await harness.turns.run({
			channel: "drain-task:room",
			kind: "owner",
			text: "report",
			speaker: OWNER_SPEAKER,
			selection: { id: "drain-task", tools: ["probe_task"], groups: [] },
		});
		expect(result).toMatchObject({ ok: true, text: "Done." });
		// Two requests are the turn's own; a task would have made a third.
		expect(requests).toBe(2);
		expect(spawned).toHaveLength(1);
	} finally {
		await harness.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});
