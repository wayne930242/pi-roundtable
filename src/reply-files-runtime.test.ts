import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createFauxCore,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { definePlugin, defineTool } from "./core/define.ts";
import type { OutboundReply } from "./core/domain/conversation.ts";
import { attachReplyFile } from "./core/reply-files.ts";
import { PiAgentRuntime } from "./core/runtime/pi-agent-runtime.ts";
import { OWNER_SPEAKER, testPlugin } from "./testing.ts";

const file = { name: "image.png", data: new Uint8Array([1, 2, 3]) };
const call = (name: string) =>
	fauxAssistantMessage(fauxToolCall(name, {}), { stopReason: "toolUse" });

async function fixture(steps: FauxResponseStep[], supportsFiles = true) {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-reply-files-"));
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
	const replies: OutboundReply[] = [];
	const harness = await testPlugin(
		definePlugin({
			name: "reply-images",
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
					}),
			},
			setup: () => ({
				tools: [
					defineTool({
						name: "make_image",
						description: "Make an image.",
						parameters: Type.Object({}),
						minTier: "member",
						run: (_args, turn) => {
							turn.attachFile(file);
							expect(replies).toEqual([]);
							return "Image attached.";
						},
					}),
				],
				// A raw session tool uses the same entry a Pi package imports.
				sessionTools: [
					{
						name: "raw-image",
						phase: "tools",
						snapshot: () => ({
							revision: 0,
							factory: () => (pi) => {
								// This isolated plugin test has no host compactor; preflight still requires its tool.
								pi.registerTool({
									name: "compact_session",
									label: "compact_session",
									description: "Test compactor registration.",
									parameters: Type.Object({}),
									execute: async () => {
										throw new Error(
											"Compaction is not scripted in this fixture.",
										);
									},
								});
								pi.registerTool({
									name: "raw_image",
									label: "raw_image",
									description: "Make an image.",
									parameters: Type.Object({}),
									execute: async () => {
										attachReplyFile(file);
										return {
											content: [{ type: "text", text: "Attached." }],
											details: {},
										};
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
					supportsFiles,
					start: async () => undefined,
					sendReply: async (_channel, reply) => {
						replies.push(reply);
					},
				},
			],
		},
	);
	return {
		harness,
		replies,
		run: () =>
			harness.turns.run({
				channel: "fake:room",
				kind: "owner",
				text: "draw",
				speaker: OWNER_SPEAKER,
				selection: {
					id: "images",
					tools: ["make_image", "raw_image"],
					groups: [],
				},
			}),
		close: async () => {
			await harness.stop();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("real Pi tool execution carries files with the final reply and accepts a textless final answer", async () => {
	for (const text of ["Here is the image.", ""]) {
		const f = await fixture([call("make_image"), fauxAssistantMessage(text)]);
		try {
			expect(await f.run()).toEqual({ ok: true, text, files: [file] });
			expect(f.replies).toEqual([
				{ chunks: text ? [text] : [], files: [file] },
			]);
		} finally {
			await f.close();
		}
	}
});

test("raw session / Pi package helpers attach through real Pi execution", async () => {
	const f = await fixture([call("raw_image"), fauxAssistantMessage("Done.")]);
	try {
		expect((await f.run()).ok).toBe(true);
		expect(f.replies[0]?.files).toEqual([file]);
	} finally {
		await f.close();
	}
});

test("a model failure after attaching posts only a failure notice", async () => {
	const f = await fixture([
		call("make_image"),
		fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "provider failed",
		}),
	]);
	try {
		expect((await f.run()).ok).toBe(false);
		expect(f.replies).toHaveLength(1);
		expect(f.replies[0]?.files).toBeUndefined();
	} finally {
		await f.close();
	}
});

test("unsupported surface refusal reaches the model as a tool error, with no dropped file", async () => {
	let errorText = "";
	const f = await fixture(
		[
			call("make_image"),
			(context) => {
				const result = context.messages.findLast(
					(message) => message.role === "toolResult",
				);
				if (result?.role === "toolResult") {
					expect(result.isError).toBe(true);
					errorText = result.content
						.map((part) => (part.type === "text" ? part.text : ""))
						.join("");
				}
				return fauxAssistantMessage("This surface cannot show files.");
			},
		],
		false,
	);
	try {
		await f.run();
		expect(errorText).toContain("does not support reply files");
		expect(f.replies[0]?.files).toBeUndefined();
	} finally {
		await f.close();
	}
});

test("stopping a real Pi turn after its tool attaches discards its files", async () => {
	let started = () => {};
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	let release = () => {};
	const waiting = new Promise<void>((resolve) => {
		release = resolve;
	});
	const f = await fixture([
		call("make_image"),
		async () => {
			started();
			await waiting;
			return fauxAssistantMessage("Late.");
		},
	]);
	try {
		const done = f.run();
		await ready;
		expect(f.harness.runtime?.stop("fake:room")).toBe(true);
		release();
		expect(await done).toMatchObject({ ok: false, stopped: true });
		expect(f.replies[0]?.files).toBeUndefined();
	} finally {
		release();
		await f.close();
	}
});
