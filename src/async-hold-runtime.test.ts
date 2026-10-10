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
import type { ChatSurface } from "./core/contract/surface.ts";
import { definePlugin, defineTool, type ToolTurn } from "./core/define.ts";
import type { PendingConfirmation } from "./core/domain/conversation.ts";
import { messages } from "./core/i18n/index.ts";
import { PiAgentRuntime } from "./core/runtime/pi-agent-runtime.ts";
import type { Speaker } from "./core/speakers.ts";
import { testPlugin } from "./testing.ts";

const MEMBER: Speaker = {
	id: "7",
	name: "Sam",
	tier: "member",
	principalId: "7",
};

/** A turn that calls `deploy`, held for approval, then waits. */
const DEPLOY_TURN = () => [
	fauxAssistantMessage([fauxToolCall("deploy", { site: "docs" })], {
		stopReason: "toolUse",
	}),
	fauxAssistantMessage([fauxText("Waiting for your go-ahead.")]),
];

/** A host with a Pi runtime on a faux model, a held `deploy` tool, and a `fake` surface. */
async function heldHost(
	turns: number,
	hold: (args: { site: string }, turn: ToolTurn) => Promise<string | undefined>,
	prompts?: ChatSurface["prompts"],
): Promise<{
	harness: Awaited<ReturnType<typeof testPlugin>>;
	saved: (PendingConfirmation | undefined)[];
	done(): Promise<void>;
}> {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-held-"));
	const core = createFauxCore({ provider: "faux", models: [{ id: "faux-1" }] });
	core.setResponses(Array.from({ length: turns }, DEPLOY_TURN).flat());
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
						hold,
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
					...(prompts ? { prompts } : {}),
				},
			],
		},
	);
	return {
		harness,
		saved,
		done: async () => {
			await harness.stop();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("a hold that looks things up as the speaker names the held call, and sees the turn the tool's run would", async () => {
	const seen: ToolTurn[] = [];
	const { harness, saved, done } = await heldHost(1, async ({ site }, turn) => {
		seen.push(turn);
		await Bun.sleep(5);
		return `deploy ${site} for ${turn.speaker?.name}`;
	});
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
			calls: [{ tool: "deploy", action: "deploy docs for Sam" }],
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]?.speaker).toEqual(MEMBER);
		expect(seen[0]?.channel).toBe("fake:room");
		expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
	} finally {
		await done();
	}
});

test("a hold that fails still holds the call, under the generic description", async () => {
	const { harness, saved, done } = await heldHost(1, async () => {
		throw new Error("directory is down");
	});
	try {
		await harness.turns.run({
			channel: "fake:room",
			kind: "helper",
			text: "deploy the docs",
			speaker: MEMBER,
			selection: { id: "held", tools: ["deploy"], groups: [] },
		});
		expect(saved.at(-1)).toMatchObject({
			calls: [{ tool: "deploy", action: messages().holdGeneric("deploy") }],
		});
	} finally {
		await done();
	}
});
