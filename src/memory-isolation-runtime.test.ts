import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	collapseSystemMessages,
	createFauxCore,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MEMORY_TIERS, memorySessionTool } from "./core/builtin/stores.ts";
import { definePlugin } from "./core/define.ts";
import type { ChannelKey } from "./core/domain/conversation.ts";
import type { TurnConversation } from "./core/domain/ports.ts";
import type {
	Memory,
	MemoryKind,
} from "./core/modules/memory/owner-memory-store.ts";
import { PiAgentRuntime } from "./core/runtime/pi-agent-runtime.ts";
import type { MemoryStore, SpeakerMemory } from "./core/services.ts";
import type { Speaker } from "./core/speakers.ts";
import { testPlugin } from "./testing.ts";

// Whose private memory a model request may carry, end to end over the real Pi runtime: a shared
// conversation's requests carry only the speaker's, whatever its history holds of someone else's.

const OWNER = {
	id: "owner",
	name: "Riley",
	pronouns: { subject: "he", object: "him", possessive: "his" },
} as const;
const ANN: Speaker = {
	id: "ann-1",
	name: "Ann",
	tier: "member",
	principalId: "ann",
};
const BO: Speaker = {
	id: "bo-1",
	name: "Bo",
	tier: "member",
	principalId: "bo",
};
const SYSTEM: Speaker = {
	id: "assistant",
	name: "Assistant",
	tier: "owner",
	principalId: "system",
};

/** Ann's facts: a core one her prompt shows, and a note only memory_search finds. */
const ANN_CORE = "ANN_CORE_SECRET is Ann's locker code";
const ANN_NOTE = "ANN_NOTE_SECRET is Ann's doctor";
const BO_CORE = "Bo studies chemistry";
const SECRETS = ["ANN_CORE_SECRET", "ANN_NOTE_SECRET"];
const HIDDEN = "(another person's private memory, hidden)";

/** Each principal's remembered facts, of the kinds given. */
function memoryOf(facts: Record<string, { fact: string; kind: MemoryKind }[]>) {
	const rows = new Map<string, Memory[]>();
	let next = 1;
	for (const [id, list] of Object.entries(facts))
		rows.set(
			id,
			list.map(({ fact, kind }) => ({
				id: next++,
				kind,
				fact,
				eventDate: null,
			})),
		);
	const of = (id: string) => rows.get(id) ?? [];
	const speaker = (id: string): SpeakerMemory => ({
		list: async () => of(id),
		forPrompt: async () => ({
			core: of(id).filter((m) => m.kind === "core"),
			events: [],
		}),
		add: async (fact: string, kind: MemoryKind = "core") => {
			const memory: Memory = { id: next++, kind, fact, eventDate: null };
			rows.set(id, [...of(id), memory]);
			return memory;
		},
		search: async (query: string) =>
			of(id).filter((m) => query.split(" ").some((q) => m.fact.includes(q))),
		update: async () => undefined,
		removeById: async () => false,
		remove: async () => [],
	});
	const store: MemoryStore = { forSpeaker: speaker };
	return store;
}

const STORE = () =>
	memoryOf({
		ann: [
			{ fact: ANN_CORE, kind: "core" },
			{ fact: ANN_NOTE, kind: "note" },
		],
		bo: [{ fact: BO_CORE, kind: "core" }],
	});

const call = (name: string, args: Record<string, string>) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

/** The request as sent, and as a provider without mid-conversation system messages receives it. */
const asSent = (context: TranscriptContext) => [
	JSON.stringify(context.messages),
	JSON.stringify(collapseSystemMessages(context).messages),
];

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/**
 * A host whose plugin offers a "study" persona with memory and a "quiz" persona without, over
 * the real Pi runtime and a faux model. `recorded` is the host's record of each conversation,
 * which the runtime reads when a turn names none; a test may change it between turns.
 */
async function isolationHost(
	store: MemoryStore,
	steps: FauxResponseStep[],
	recorded = new Map<ChannelKey, TurnConversation>(),
) {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-memory-isolation-"));
	dirs.push(dir);
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
	const harness = await testPlugin(
		definePlugin({
			name: "isolation",
			providers: {
				runtime: (deps) =>
					new PiAgentRuntime({
						owner: OWNER,
						agentDir: dir,
						dataDir: dir,
						modelRuntime,
						model: { provider: "faux", id: "faux-1" },
						thinking: "off",
						effort: { judge: async () => "off" },
						sessions: deps.sessions,
						conversationOf: async (key) => recorded.get(key),
						logger: deps.logger,
						confirmations: deps.confirmations,
						toolTiers: deps.toolTiers,
					}),
			},
			setup: () => ({
				personas: [
					{ kind: "study", prompt: () => "You are a tutor." },
					{ kind: "quiz", prompt: () => "You ask questions.", memory: "none" },
				],
				sessionTools: [
					memorySessionTool(store, OWNER),
					{
						name: "probe",
						phase: "tools",
						snapshot: () => ({
							revision: 0,
							factory: (session) => (pi) => {
								pi.registerTool({
									name: "probe_task",
									label: "probe_task",
									description: "Ask a worker to look something up.",
									parameters: Type.Object({}),
									execute: async () => {
										const text = await session.runTask({
											selection: { tools: ["memory_search"], groups: [] },
											text: "Look it up.",
											timeoutMs: 10_000,
											exclude: [],
										});
										return { content: [{ type: "text", text }], details: {} };
									},
								});
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
				toolTiers: { ...MEMORY_TIERS, probe_task: "member" },
			}),
		}),
		{
			owner: { id: OWNER.id, name: OWNER.name },
			surfaces: [
				{
					surface: "fake",
					start: async () => undefined,
					sendReply: async () => undefined,
				},
			],
		},
	);
	const { runtime } = harness;
	if (!runtime) throw new Error("the plugin fills the runtime slot");
	return {
		recorded,
		/** A turn of the speaker's in the channel, naming its conversation when one is given. */
		run: (
			speaker: Speaker,
			channel: ChannelKey,
			options: { conversation?: TurnConversation; kind?: string } = {},
		) =>
			runtime.runTurn({
				channel,
				kind: options.kind ?? "study",
				text: "Hello.",
				speaker,
				selection: {
					id: "study",
					tools: ["memory_add", "memory_search", "memory_remove", "probe_task"],
					groups: [],
				},
				...(options.conversation ? { conversation: options.conversation } : {}),
			}),
		stop: () => harness.stop(),
	};
}

describe("memory in a shared conversation's history", () => {
	test("another speaker's and the host's requests carry none of Ann's memory; Ann's own next turn still does", async () => {
		const seen: TranscriptContext[] = [];
		const look: FauxResponseStep = (context) => {
			seen.push(context);
			return fauxAssistantMessage("OK.");
		};
		const host = await isolationHost(STORE(), [
			// Ann's turn finds her note; her prompt shows her core fact.
			() => call("memory_search", { query: "doctor" }),
			look,
			look,
			look,
			look,
		]);
		try {
			expect((await host.run(ANN, "fake:room")).ok).toBe(true);
			const [ann] = seen.splice(0);
			if (!ann) throw new Error("Ann's turn asked nothing after its search");
			// The search found her note, in her own turn.
			expect(JSON.stringify(ann.messages)).toContain("ANN_NOTE_SECRET");
			expect((await host.run(BO, "fake:room")).ok).toBe(true);
			expect((await host.run(SYSTEM, "fake:room")).ok).toBe(true);
			expect((await host.run(ANN, "fake:room")).ok).toBe(true);
			const [bo, system, again] = seen;
			if (!bo || !system || !again) throw new Error("a turn asked nothing");
			for (const request of [bo, system])
				for (const sent of asSent(request)) {
					for (const secret of SECRETS) expect(sent).not.toContain(secret);
					expect(sent).toContain(HIDDEN);
				}
			// Bo's own memory is his request's.
			for (const sent of asSent(bo)) expect(sent).toContain(BO_CORE);
			for (const sent of asSent(again)) {
				expect(sent).toContain("ANN_NOTE_SECRET");
				expect(sent).toContain("ANN_CORE_SECRET");
				expect(sent).not.toContain(HIDDEN);
				expect(sent).not.toContain(BO_CORE);
			}
		} finally {
			await host.stop();
		}
	});

	test("a memory result records in the session whose memory it holds", async () => {
		const seen: TranscriptContext[] = [];
		const host = await isolationHost(STORE(), [
			() => call("memory_search", { query: "doctor" }),
			(context) => {
				seen.push(context);
				return fauxAssistantMessage("OK.");
			},
		]);
		try {
			expect((await host.run(ANN, "fake:room")).ok).toBe(true);
			const [own] = seen;
			if (!own) throw new Error("Ann's turn asked nothing after its search");
			// Within her own turn the result is hers, and says so.
			const result = own.messages.findLast((m) => m.role === "toolResult");
			expect(result?.role === "toolResult" && result.details).toEqual({
				privateTo: "ann",
			});
		} finally {
			await host.stop();
		}
	});
});
