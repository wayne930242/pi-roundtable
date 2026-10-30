import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createFauxCore,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { definePlugin } from "./core/define.ts";
import type { TurnResult } from "./core/domain/conversation.ts";
import { TurnTimeoutError } from "./core/domain/turn-timeout.ts";
import { PiAgentRuntime } from "./core/runtime/pi-agent-runtime.ts";
import { OWNER_SPEAKER, testPlugin } from "./testing.ts";

const slowCall = fauxAssistantMessage([fauxToolCall("slow_task", {})], {
	stopReason: "toolUse",
});
const done = fauxAssistantMessage([fauxText("done")]);

/**
 * A real Pi turn on a surface with no cards, whose model plays `steps`; `slow_task` takes `toolMs`.
 * `run` starts a turn someone waits on unless it is told it is unattended.
 */
async function fixture(
	steps: FauxResponseStep[],
	options: {
		toolMs?: number;
		turnTimeoutMs?: number;
		longRunningMaxMs?: number;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-unattended-"));
	const core = createFauxCore({ provider: "faux", models: [{ id: "faux-1" }] });
	core.setResponses(steps);
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
	const sent: string[][] = [];
	const harness = await testPlugin(
		definePlugin({
			name: "unattended",
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
						turnAbortGraceMs: 200,
						...(options.turnTimeoutMs
							? { turnTimeoutMs: options.turnTimeoutMs }
							: {}),
						...(options.longRunningMaxMs
							? {
									autonomy: {
										yolo: { allow: [], card: [] },
										longRunningMaxMs: options.longRunningMaxMs,
									},
								}
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
										await new Promise<void>((finish) => {
											const timer = setTimeout(finish, options.toolMs ?? 0);
											signal?.addEventListener("abort", () => {
												clearTimeout(timer);
												finish();
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
				},
			],
		},
	);
	return {
		sent,
		run: (
			extra: {
				interactive?: boolean;
				unattended?: boolean;
				timeLimitMs?: number;
			} = {},
		): Promise<TurnResult> =>
			harness.turns.run({
				channel: "fake:room",
				kind: "owner",
				text: "hello",
				speaker: OWNER_SPEAKER,
				selection: { id: "slow", tools: ["slow_task", "ask_user"], groups: [] },
				...extra,
			}),
		close: async () => {
			await harness.stop();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

const empty = fauxAssistantMessage([fauxText("")]);

test("an unattended turn with nothing to say ends quietly: no failure, nothing posted", async () => {
	const f = await fixture([empty]);
	try {
		expect(await f.run({ unattended: true })).toEqual({ ok: true, text: "" });
		expect(f.sent).toEqual([]);
	} finally {
		await f.close();
	}
});

test("a turn someone waits on, such as a remote caller's, still fails on an empty final answer", async () => {
	const f = await fixture([empty]);
	try {
		const result = await f.run();
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toBe(
			"the final assistant message has no text",
		);
		expect(f.sent).toHaveLength(1);
	} finally {
		await f.close();
	}
});

test("an unattended turn that says something still posts it", async () => {
	const f = await fixture([done]);
	try {
		expect(await f.run({ unattended: true })).toMatchObject({
			ok: true,
			text: "done",
		});
		expect(f.sent).toEqual([["done"]]);
	} finally {
		await f.close();
	}
});

test("an unattended turn stopped at its limit posts why, and how to allow more time", async () => {
	const f = await fixture([slowCall, done], {
		toolMs: 5_000,
		turnTimeoutMs: 150,
	});
	try {
		const result = await f.run({ unattended: true });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBeInstanceOf(TurnTimeoutError);
		const notice = f.sent.at(-1)?.[0] ?? "";
		expect(notice).toContain("reached its time limit");
		expect(notice).toContain("No one was in the conversation to ask");
		expect(notice).toContain("turn on long-running");
	} finally {
		await f.close();
	}
});

test("a time limit of its own replaces the runtime's default for that turn", async () => {
	const f = await fixture([slowCall, done, slowCall], {
		toolMs: 500,
		turnTimeoutMs: 150,
	});
	try {
		// The default limit would stop a 500 ms tool; the turn's own limit lets it finish.
		expect(await f.run({ timeLimitMs: 5_000 })).toMatchObject({
			ok: true,
			text: "done",
		});
		// And a shorter one stops it, whatever the default.
		const stopped = await f.run({ timeLimitMs: 100 });
		expect(stopped.ok).toBe(false);
		if (stopped.ok) return;
		expect(stopped.error).toBeInstanceOf(TurnTimeoutError);
		expect((stopped.error as TurnTimeoutError).timeout.limitMs).toBe(100);
	} finally {
		await f.close();
	}
});

test("a turn's own time limit never passes the long-running cap", async () => {
	const f = await fixture([slowCall, done], {
		toolMs: 5_000,
		longRunningMaxMs: 300,
	});
	try {
		const result = await f.run({ timeLimitMs: 60 * 60_000 });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		const { timeout } = result.error as TurnTimeoutError;
		expect(timeout.limitMs).toBe(300);
		expect(timeout.workedMs).toBeLessThan(2_000);
	} finally {
		await f.close();
	}
});

test("ask_user in an unattended turn refuses at once and the question goes out as the answer", async () => {
	const f = await fixture([
		fauxAssistantMessage([fauxToolCall("ask_user", { question: "Which?" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxText("Which one do you want, A or B?")]),
	]);
	try {
		const started = Date.now();
		expect(await f.run({ unattended: true })).toMatchObject({
			ok: true,
			text: "Which one do you want, A or B?",
		});
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(f.sent).toEqual([["Which one do you want, A or B?"]]);
	} finally {
		await f.close();
	}
});
