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
import { definePlugin } from "./core/define.ts";
import type { TurnResult } from "./core/domain/conversation.ts";
import { TurnTimeoutError } from "./core/domain/turn-timeout.ts";
import type {
	Approval,
	ApprovalOptions,
	Prompts,
} from "./core/interactions/prompts.ts";
import { PiAgentRuntime } from "./core/runtime/pi-agent-runtime.ts";
import { OWNER_SPEAKER, testPlugin } from "./testing.ts";

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * A real Pi turn whose model calls `slow_task`, a tool that takes `toolMs`, then answers "done";
 * the surface records each card and lets the test answer it.
 */
async function fixture(options: {
	toolMs: number;
	turnTimeoutMs: number;
	turnTimeoutCardMs?: number;
	cards: boolean;
}) {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-timeout-card-"));
	const core = createFauxCore({ provider: "faux", models: [{ id: "faux-1" }] });
	core.setResponses([
		fauxAssistantMessage([fauxToolCall("slow_task", {})], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxText("done")]),
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
	const cards: {
		message: string;
		options: ApprovalOptions | undefined;
		answer: (approval: Approval) => void;
	}[] = [];
	const prompts: Prompts = {
		confirm: (_title, message, _signal, _minTier, _wait, _details, opts) =>
			new Promise<Approval>((answer) => {
				cards.push({ message, options: opts, answer });
				opts?.supersede?.addEventListener("abort", () => answer("cancelled"));
			}),
		ask: async () => undefined,
	};
	const sent: string[][] = [];
	const harness = await testPlugin(
		definePlugin({
			name: "timeout-card",
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
						turnTimeoutMs: options.turnTimeoutMs,
						turnAbortGraceMs: 200,
						...(options.turnTimeoutCardMs
							? { turnTimeoutCardMs: options.turnTimeoutCardMs }
							: {}),
					}),
			},
			setup: () => ({
				sessionTools: [
					{
						name: "slow",
						phase: "tools",
						snapshot: () => ({
							revision: 0,
							factory: () => (pi) => {
								pi.registerTool({
									name: "slow_task",
									label: "slow_task",
									description: "Takes a while.",
									parameters: Type.Object({}),
									execute: async (_id, _params, signal) => {
										await new Promise<void>((done) => {
											const timer = setTimeout(done, options.toolMs);
											signal?.addEventListener("abort", () => {
												clearTimeout(timer);
												done();
											});
										});
										return {
											content: [{ type: "text", text: "finished" }],
											details: {},
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
		{
			surfaces: [
				{
					surface: "fake",
					start: async () => undefined,
					sendReply: async (_channel, reply) => {
						sent.push(reply.chunks);
					},
					...(options.cards ? { prompts: () => prompts } : {}),
				},
			],
		},
	);
	return {
		cards,
		sent,
		run: (): Promise<TurnResult> =>
			harness.turns.run({
				channel: "fake:room",
				kind: "owner",
				text: "hello",
				speaker: OWNER_SPEAKER,
				selection: { id: "slow", tools: ["slow_task"], groups: [] },
				interactive: true,
			}),
		close: async () => {
			await harness.stop();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("a turn that finishes while its timeout card is open closes the card and replies as usual", async () => {
	const f = await fixture({ toolMs: 400, turnTimeoutMs: 150, cards: true });
	try {
		const result = await f.run();
		expect(result).toMatchObject({ ok: true, text: "done" });
		expect(f.cards).toHaveLength(1);
		expect(f.cards[0]?.message).toContain("slow_task, running for");
		expect(f.cards[0]?.options?.supersede?.aborted).toBe(true);
		expect(f.sent.at(-1)).toEqual(["done"]);
	} finally {
		await f.close();
	}
});

test("Cancel on the timeout card aborts the turn and the posted failure names why", async () => {
	const f = await fixture({ toolMs: 5_000, turnTimeoutMs: 150, cards: true });
	try {
		const turn = f.run();
		while (f.cards.length === 0) await sleep(10);
		f.cards[0]?.answer("declined");
		const result = await turn;
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBeInstanceOf(TurnTimeoutError);
		expect((result.error as TurnTimeoutError).timeout.end).toBe("cancelled");
		expect(result.error.message).toContain(
			"Cancelled by the owner after 0 s while slow_task was running",
		);
		expect(f.sent.at(-1)?.[0]).toContain("Cancelled by the owner");
	} finally {
		await f.close();
	}
});

test("a turn with no card surface aborts at its limit, and its error and posted failure carry the reason", async () => {
	const f = await fixture({ toolMs: 5_000, turnTimeoutMs: 150, cards: false });
	try {
		const result = await f.run();
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBeInstanceOf(TurnTimeoutError);
		expect(result.error.message).toContain("while slow_task was running");
		expect(result.error.message).toContain("Tools so far: slow_task.");
		expect(f.sent.at(-1)?.[0]).toContain("reached its time limit");
		expect(f.cards).toEqual([]);
	} finally {
		await f.close();
	}
});
