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
import { definePlugin, defineTool } from "./core/define.ts";
import type { PendingConfirmation } from "./core/domain/conversation.ts";
import { PiAgentRuntime } from "./core/runtime/pi-agent-runtime.ts";
import type { Speaker } from "./core/speakers.ts";
import { testPlugin } from "./testing.ts";

const MEMBER: Speaker = {
	id: "7",
	name: "Sam",
	tier: "member",
	principalId: "7",
};

test("a Pi turn's held calls carry the speaker whose turn held them, so only they and the owner approve them", async () => {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-held-"));
	const core = createFauxCore({ provider: "faux", models: [{ id: "faux-1" }] });
	core.setResponses([
		fauxAssistantMessage([fauxToolCall("deploy", { site: "docs" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxText("Waiting for your go-ahead.")]),
	]);
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
	const saved: (PendingConfirmation | undefined)[] = [];
	const harness = await testPlugin(
		definePlugin({
			name: "held",
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
						toolTiers: deps.toolTiers,
						logger: deps.logger,
						confirmations: {
							load: (conversation) => deps.confirmations.load(conversation),
							save: async (conversation, held) => {
								saved.push(held);
								await deps.confirmations.save(conversation, held);
							},
						},
						prompts: deps.prompts,
					}),
			},
			setup: () => ({
				personas: [{ kind: "helper", prompt: () => "Help the person." }],
				tools: [
					defineTool({
						name: "deploy",
						description: "Deploy a site.",
						parameters: Type.Object({ site: Type.String() }),
						minTier: "member",
						hold: ({ site }) => `deploy ${site}`,
						run: () => "deployed",
					}),
				],
				sessionTools: [
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
		{
			surfaces: [
				{
					surface: "fake",
					start: async () => undefined,
					sendReply: async () => undefined,
				},
			],
		},
	);
	try {
		await harness.turns.run({
			channel: "fake:room",
			kind: "helper",
			text: "deploy the docs",
			speaker: MEMBER,
			selection: { id: "held", tools: ["deploy"], groups: [] },
		});
		expect(saved.at(-1)).toMatchObject({
			speakerId: MEMBER.id,
			calls: [{ tool: "deploy", action: "deploy docs" }],
		});
	} finally {
		await harness.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});
