import { mkdtempSync } from "node:fs";
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
import { testPlugin } from "../../../testing.ts";
import { MEMORY_TIERS, memorySessionTool } from "../../builtin/stores.ts";
import type { HeldActionStore } from "../../contract/runtime.ts";
import type { ChannelKey } from "../../domain/conversation.ts";
import type { TurnConversation } from "../../domain/ports.ts";
import type { SessionTool } from "../../domain/sessions.ts";
import type { Speaker } from "../../identity/speakers.ts";
import type {
	Memory,
	MemoryKind,
} from "../../modules/memory/owner-memory-store.ts";
import { definePlugin, defineTool } from "../../plugin-api/define.ts";
import type { MemoryStore, SpeakerMemory } from "../../plugin-api/services.ts";
import { PiAgentRuntime } from "../../runtime/pi-agent-runtime.ts";

// Whose private memory a model request may carry, end to end over the real Pi runtime: a shared
// conversation's requests carry only the speaker's, whatever its history holds of someone else's.

export const OWNER = {
	id: "owner",
	name: "Riley",
	pronouns: { subject: "he", object: "him", possessive: "his" },
} as const;

export const ANN: Speaker = {
	id: "ann-1",
	name: "Ann",
	tier: "member",
	principalId: "ann",
};

export const BO: Speaker = {
	id: "bo-1",
	name: "Bo",
	tier: "member",
	principalId: "bo",
};

export const SYSTEM: Speaker = {
	id: "assistant",
	name: "Assistant",
	tier: "owner",
	principalId: "system",
};

/** Ann's facts: a core one her prompt shows, and a note only memory_search finds. */
export const ANN_CORE = "ANN_CORE_SECRET is Ann's locker code";

export const ANN_NOTE = "ANN_NOTE_SECRET is Ann's doctor";

export const BO_CORE = "Bo studies chemistry";

export const SECRETS = ["ANN_CORE_SECRET", "ANN_NOTE_SECRET"];

export const HIDDEN = "(another person's private memory, hidden)";

/** What `public_wait` answers: the public state of a queue, no one's memory. */
export const QUEUE = "QUEUE_PUBLIC: 3 jobs are waiting";

/** Each principal's remembered facts, of the kinds given. */
export function memoryOf(
	facts: Record<string, { fact: string; kind: MemoryKind }[]>,
) {
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

export const STORE = () =>
	memoryOf({
		ann: [
			{ fact: ANN_CORE, kind: "core" },
			{ fact: ANN_NOTE, kind: "note" },
		],
		bo: [{ fact: BO_CORE, kind: "core" }],
	});

export const call = (name: string, args: Record<string, string>) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

/** The request as sent, and as a provider without mid-conversation system messages receives it. */
export const asSent = (context: TranscriptContext) => [
	JSON.stringify(context.messages),
	JSON.stringify(collapseSystemMessages(context).messages),
];

export const dirs: string[] = [];

/**
 * A compaction extension placed through the core's wrapper, as the core's own is, that hands on the text of
 * what it is asked to summarize and answers with a summary of its own.
 */
export function compactorTool(summarized: (text: string) => void): SessionTool {
	return {
		name: "recording-compactor",
		phase: "compaction",
		engine: "recording",
		snapshot: () => ({
			revision: 0,
			factory: (session) =>
				session.compaction.wrap((pi) => {
					pi.on("session_before_compact", ({ preparation }) => {
						summarized(
							JSON.stringify([
								...preparation.messagesToSummarize,
								...preparation.turnPrefixMessages,
							]),
						);
						return {
							compaction: {
								summary: "A summary.",
								firstKeptEntryId: preparation.firstKeptEntryId,
								tokensBefore: preparation.tokensBefore,
								details: { engine: "recording" },
							},
						};
					});
				}),
		}),
	};
}

/**
 * A host whose plugin offers a "study" persona with memory and a "quiz" persona without, over
 * the real Pi runtime and a faux model. `recorded` is the host's record of each conversation,
 * which the runtime reads when a turn names none; a test may change it between turns.
 */
export async function isolationHost(
	store: MemoryStore,
	steps: FauxResponseStep[],
	options: {
		recorded?: Map<ChannelKey, TurnConversation>;
		/** The data directory of an earlier host, to start again over its sessions. */
		dir?: string;
		/** The held actions' store, an earlier host's to start again over what it held. */
		held?: HeldActionStore;
		/** Receives what a compaction extension, placed through the core's wrapper, would summarize. */
		compactor?: (summarized: string) => void;
		provider?: string;
	} = {},
) {
	const recorded = options.recorded ?? new Map<ChannelKey, TurnConversation>();
	const dir =
		options.dir ?? mkdtempSync(join(tmpdir(), "roundtable-memory-isolation-"));
	if (!options.dir) dirs.push(dir);
	// The probe tool's revision; a test bumps it to rebuild every session for changed tools.
	let revision = 0;
	// The sites `deploy` ran for, once its held call was approved.
	const deployed: string[] = [];
	// `public_wait` answers once a `probe_task` beside it got its worker's report.
	let reported = () => {};
	const report = new Promise<void>((resolve) => {
		reported = resolve;
	});
	const provider = options.provider ?? "faux";
	const core = createFauxCore({ provider, models: [{ id: "faux-1" }] });
	core.setResponses(steps);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	modelRuntime.registerProvider(provider, {
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
						model: { provider, id: "faux-1" },
						memory: true,
						thinking: "off",
						effort: { judge: async () => "off" },
						sessions: deps.sessions,
						conversationOf: async (key) => recorded.get(key),
						logger: deps.logger,
						confirmations: options.held ?? deps.confirmations,
						toolTiers: deps.toolTiers,
					}),
			},
			setup: () => ({
				tools: [
					defineTool({
						name: "deploy",
						description: "Deploy a site.",
						parameters: Type.Object({ site: Type.String() }),
						minTier: "member",
						hold: ({ site }) => `deploy ${site}`,
						run: ({ site }) => {
							deployed.push(site);
							return "deployed";
						},
					}),
				],
				personas: [
					{ kind: "study", prompt: () => "You are a tutor." },
					{ kind: "quiz", prompt: () => "You ask questions.", memory: "none" },
				],
				sessionTools: [
					memorySessionTool(store, OWNER),
					...(options.compactor ? [compactorTool(options.compactor)] : []),
					{
						name: "probe",
						phase: "tools",
						snapshot: () => ({
							revision,
							factory: (session) => (pi) => {
								pi.registerTool({
									name: "probe_task",
									label: "probe_task",
									description: "Ask a worker to look something up.",
									parameters: Type.Object({}),
									execute: async () => {
										const text = await session.runTask({
											selection: {
												tools: ["memory_search", "probe_task"],
												groups: [],
											},
											text: "Look it up.",
											timeoutMs: 10_000,
											exclude: [],
										});
										reported();
										return { content: [{ type: "text", text }], details: {} };
									},
								});
								pi.registerTool({
									name: "public_wait",
									label: "public_wait",
									description: "Wait for the public queue.",
									parameters: Type.Object({}),
									execute: async () => {
										await Promise.race([
											report,
											new Promise((resolve) => setTimeout(resolve, 5_000)),
										]);
										return {
											content: [{ type: "text", text: QUEUE }],
											details: {},
										};
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
				toolTiers: {
					...MEMORY_TIERS,
					probe_task: "member",
					public_wait: "member",
				},
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
		dir,
		runtime,
		recorded,
		deployed,
		pending: () => core.getPendingResponseCount(),
		/** Changes the tools of every session, which rebuilds each at its next turn. */
		bumpTools: () => {
			revision += 1;
		},
		/** A turn of the speaker's in the channel, naming its conversation when one is given. */
		run: (
			speaker: Speaker,
			channel: ChannelKey,
			options: {
				conversation?: TurnConversation;
				kind?: string;
				text?: string;
				/** The turn approves what is held for the conversation. */
				confirmed?: boolean;
			} = {},
		) =>
			runtime.runTurn({
				channel,
				kind: options.kind ?? "study",
				text: options.text ?? "Hello.",
				speaker,
				selection: {
					id: "study",
					tools: [
						"memory_add",
						"memory_search",
						"memory_remove",
						"probe_task",
						"public_wait",
						"deploy",
					],
					groups: [],
				},
				...(options.conversation ? { conversation: options.conversation } : {}),
				...(options.confirmed ? { confirmed: true } : {}),
			}),
		stop: () => harness.stop(),
	};
}

/** What Ann wrote in her own conversation, which no one else's request may replay. */
export const DIARY = "ANN_DIARY_SECRET: I am changing jobs.";

export const privateTo = (principalId: string): TurnConversation => ({
	visibility: "private",
	principalId,
});

/** Steps that record each request in `seen` and answer it. */
export const looking = (
	seen: TranscriptContext[],
	count: number,
): FauxResponseStep[] =>
	Array.from({ length: count }, () => (context: TranscriptContext) => {
		seen.push(context);
		return fauxAssistantMessage("OK.");
	});
