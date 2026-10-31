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
import type { Prompts, PromptWait } from "./core/interactions/prompts.ts";
import { PiAgentRuntime } from "./core/runtime/pi-agent-runtime.ts";
import { OWNER_SPEAKER, testPlugin } from "./testing.ts";

/** Every string in a value, in order: the text of the request's system messages, however Pi lays them out. */
function textOf(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(textOf);
	if (value && typeof value === "object")
		return Object.values(value).flatMap(textOf);
	return [];
}

/**
 * A real Pi turn whose model calls `ask_user`, in a conversation whose yolo mode is `yolo`; the
 * surface leaves the card unanswered and records the turn's wait, and the model records what the
 * tool told it and its system prompt.
 */
async function fixture(options: { yolo: boolean; questionGraceMs?: number }) {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-yolo-ask-"));
	const core = createFauxCore({ provider: "faux", models: [{ id: "faux-1" }] });
	const seen: { result?: string; system?: string } = {};
	core.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("ask_user", { questions: [{ question: "Which day?" }] })],
			{ stopReason: "toolUse" },
		),
		(context) => {
			const last = context.messages.at(-1);
			if (last?.role === "toolResult")
				seen.result = last.content
					.map((part) => (part.type === "text" ? part.text : ""))
					.join("");
			seen.system = textOf(
				context.messages.filter((message) => message.role === "system"),
			).join("\n");
			return fauxAssistantMessage([fauxText("done")]);
		},
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
	const waits: PromptWait[] = [];
	const prompts: Prompts = {
		confirm: async () => "declined",
		ask: async (_title, _question, _signal, wait) => {
			if (wait) waits.push(wait);
			return "pending";
		},
	};
	const harness = await testPlugin(
		definePlugin({
			name: "yolo-ask-runtime",
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
						modes: {
							peek: () => ({ yolo: options.yolo, longRunning: false }),
							autoApproved: () => undefined,
						},
						autonomy: {
							yolo: {
								allow: [],
								card: [],
								...(options.questionGraceMs === undefined
									? {}
									: { questionGraceMs: options.questionGraceMs }),
							},
							longRunningMaxMs: 60_000,
						},
					}),
			},
			setup: () => ({
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
					prompts: () => prompts,
				},
			],
		},
	);
	return {
		waits,
		seen,
		run: () =>
			harness.turns.run({
				channel: "fake:room",
				kind: "owner",
				text: "plan the trip",
				speaker: OWNER_SPEAKER,
				selection: { id: "ask", tools: ["ask_user"], groups: [] },
				interactive: true,
			}),
		close: async () => {
			await harness.stop();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("in a yolo conversation ask_user waits 30 seconds and tells the turn to keep working", async () => {
	const f = await fixture({ yolo: true });
	try {
		expect(await f.run()).toMatchObject({ ok: true, text: "done" });
		expect(f.waits.map((w) => w.graceMs)).toEqual([30_000]);
		expect(f.seen.result).toContain("yolo mode is on in this conversation");
		expect(f.seen.result).not.toContain("End your turn now");
		expect(f.seen.system).toContain("Yolo mode is on in this conversation");
	} finally {
		await f.close();
	}
});

test("the configured question grace reaches the card", async () => {
	const f = await fixture({ yolo: true, questionGraceMs: 7_000 });
	try {
		await f.run();
		expect(f.waits.map((w) => w.graceMs)).toEqual([7_000]);
	} finally {
		await f.close();
	}
});

test("outside yolo ask_user keeps the surface's grace and tells the turn to end waiting", async () => {
	const f = await fixture({ yolo: false });
	try {
		await f.run();
		expect(f.waits.map((w) => w.graceMs)).toEqual([undefined]);
		expect(f.seen.result).toContain("End your turn now");
		expect(f.seen.system).toBeDefined();
		expect(f.seen.system).not.toContain("Yolo mode is on");
	} finally {
		await f.close();
	}
});
