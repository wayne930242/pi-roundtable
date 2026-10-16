import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { definePlugin } from "./core/define.ts";
import type { ChannelKey } from "./core/domain/conversation.ts";
import { PiAgentRuntime } from "./core/runtime/pi-agent-runtime.ts";
import { OWNER_SPEAKER, testPlugin } from "./testing.ts";

const TABLES = "Reply formatting (test chat): no Markdown tables.";
const PLAIN = "Reply formatting (plain chat): plain text only.";

/** Every string in a value, in order: the text of the request's system messages, however Pi lays them out. */
function textOf(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(textOf);
	if (value && typeof value === "object")
		return Object.values(value).flatMap(textOf);
	return [];
}

/** The system prompt of a request: its system messages' text. */
const systemPrompt = (context: TranscriptContext): string =>
	textOf(context.messages.filter((message) => message.role === "system")).join(
		"\n",
	);

/** Real Pi turns over a faux model that records the system prompt of each request it gets. */
async function fixture(surfaces: { surface: string; formatting?: string }[]) {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-formatting-"));
	const core = createFauxCore({ provider: "faux", models: [{ id: "faux-1" }] });
	const prompts: string[] = [];
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
	const harness = await testPlugin(
		definePlugin({
			name: "formatting",
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
						...(deps.formatting ? { formatting: deps.formatting } : {}),
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
										const report = await session.runTask({
											selection: { tools: [], groups: [] },
											text: "Look it up.",
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
		{
			surfaces: surfaces.map((surface) => ({
				...surface,
				start: async () => undefined,
				sendReply: async () => undefined,
			})),
		},
	);
	return {
		/** The system prompt the model got for one turn that arrived on `channel`. */
		async promptOn(channel: ChannelKey): Promise<string> {
			core.appendResponses([
				(context) => {
					prompts.push(systemPrompt(context));
					return fauxAssistantMessage([fauxText("ok")]);
				},
			]);
			const before = prompts.length;
			const result = await harness.turns.run({
				channel,
				kind: "owner",
				text: "hello",
				speaker: OWNER_SPEAKER,
				selection: { id: "formatting", tools: [], groups: [] },
			});
			expect(result.ok).toBe(true);
			const prompt = prompts[before] ?? prompts.at(-1);
			if (prompt === undefined) throw new Error("the model got no request");
			return prompt;
		},
		/**
		 * The system prompts of a turn on `channel` that runs a task beside itself: the turn's first
		 * request, the task worker's, and the turn's last.
		 */
		async promptsWithWorker(channel: ChannelKey): Promise<string[]> {
			const record =
				(reply: AssistantMessage) => (context: TranscriptContext) => {
					prompts.push(systemPrompt(context));
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
			const before = prompts.length;
			const result = await harness.turns.run({
				channel,
				kind: "owner",
				text: "hello",
				speaker: OWNER_SPEAKER,
				selection: { id: "formatting", tools: ["probe_task"], groups: [] },
			});
			expect(result.ok).toBe(true);
			return prompts.slice(before);
		},
		close: async () => {
			await harness.stop();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("a turn's system prompt carries the guidance of the surface it replies on, after the persona, and not another surface's", async () => {
	const f = await fixture([
		{ surface: "tables", formatting: TABLES },
		{ surface: "plain", formatting: PLAIN },
	]);
	try {
		const onTables = await f.promptOn("tables:room");
		expect(onTables).toContain(TABLES);
		expect(onTables).not.toContain(PLAIN);
		expect(onTables.indexOf("You are the persona.")).toBeGreaterThanOrEqual(0);
		expect(onTables.indexOf(TABLES)).toBeGreaterThan(
			onTables.indexOf("You are the persona."),
		);
		const onPlain = await f.promptOn("plain:room");
		expect(onPlain).toContain(PLAIN);
		expect(onPlain).not.toContain(TABLES);
	} finally {
		await f.close();
	}
});

test("a surface without guidance, and a channel with no surface, add nothing", async () => {
	const f = await fixture([
		{ surface: "tables", formatting: TABLES },
		{ surface: "bare" },
	]);
	try {
		const bare = await f.promptOn("bare:room");
		expect(bare).toContain("You are the persona.");
		expect(bare).not.toContain("Reply formatting");
		const unserved = await f.promptOn("schedule:nightly");
		expect(unserved).toContain("You are the persona.");
		expect(unserved).not.toContain("Reply formatting");
	} finally {
		await f.close();
	}
});

test("a task worker beside a turn gets no reply guidance, while its turn's requests keep it", async () => {
	const f = await fixture([{ surface: "tables", formatting: TABLES }]);
	try {
		const [first, worker, last] = await f.promptsWithWorker("tables:room");
		expect(first).toContain(TABLES);
		expect(worker).not.toContain(TABLES);
		expect(worker).not.toContain("Reply formatting");
		expect(last).toContain(TABLES);
	} finally {
		await f.close();
	}
});

test("a surface whose guidance is blank adds nothing", async () => {
	const f = await fixture([{ surface: "blank", formatting: "" }]);
	try {
		const prompt = await f.promptOn("blank:room");
		expect(prompt).toContain("You are the persona.");
		expect(prompt).not.toMatch(/You are the persona\.\s*\n\s*\n\s*$/);
		expect(prompt.endsWith("\n")).toBe(false);
	} finally {
		await f.close();
	}
});
