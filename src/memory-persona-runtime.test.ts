import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
import type {
	Memory,
	MemoryKind,
} from "./core/modules/memory/owner-memory-store.ts";
import { PiAgentRuntime } from "./core/runtime/pi-agent-runtime.ts";
import type { MemoryStore, SpeakerMemory } from "./core/services.ts";
import type { Speaker } from "./core/speakers.ts";
import { testPlugin } from "./testing.ts";

const OWNER = {
	id: "owner",
	name: "Riley",
	pronouns: { subject: "he", object: "him", possessive: "his" },
} as const;
const MEMBER: Speaker = {
	id: "member-7",
	name: "Ada",
	tier: "member",
	principalId: "member-7",
};
const ADMIN: Speaker = {
	id: "admin-3",
	name: "Kai",
	tier: "admin",
	principalId: "admin-3",
};
const OWNER_SPEAKER: Speaker = {
	id: OWNER.id,
	name: OWNER.name,
	tier: "owner",
	principalId: OWNER.id,
};

/** Every speaker's facts in memory, keyed by speaker id, with the reads and writes each took. */
function memoryOf(facts: Record<string, string[]>) {
	const rows = new Map<string, Memory[]>();
	let next = 1;
	for (const [id, list] of Object.entries(facts))
		rows.set(
			id,
			list.map((fact) => ({ id: next++, kind: "core", fact, eventDate: null })),
		);
	const writes: { speaker: string; fact: string }[] = [];
	const reads: string[] = [];
	const of = (id: string) => rows.get(id) ?? [];
	const speaker = (id: string): SpeakerMemory => ({
		list: async () => of(id),
		forPrompt: async () => {
			reads.push(id);
			return {
				core: of(id).filter((m) => m.kind === "core"),
				events: [],
			};
		},
		add: async (fact: string, kind: MemoryKind = "core") => {
			writes.push({ speaker: id, fact });
			const memory: Memory = { id: next++, kind, fact, eventDate: null };
			rows.set(id, [...of(id), memory]);
			return memory;
		},
		search: async (query: string) => {
			reads.push(id);
			return of(id).filter((m) => m.fact.includes(query));
		},
		update: async () => undefined,
		removeById: async () => false,
		remove: async () => [],
	});
	const store: MemoryStore = { forSpeaker: speaker };
	return { store, writes, reads };
}

const call = (name: string, args: Record<string, string>) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

/** Every system message of the request, the prompt and its sections, as one searchable text. */
const systemOf = (context: TranscriptContext) =>
	JSON.stringify(context.messages.filter((m) => m.role === "system"));

const toolText = (context: TranscriptContext) => {
	const result = context.messages.findLast((m) => m.role === "toolResult");
	return result?.role === "toolResult"
		? result.content.map((p) => (p.type === "text" ? p.text : "")).join("")
		: "";
};

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A host whose one plugin is a persona conversation, run by the real Pi runtime over the memory tools. */
async function studyRoom(store: MemoryStore, steps: FauxResponseStep[]) {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-memory-persona-"));
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
			name: "study-room",
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
						name: "compactor-stub",
						phase: "tools",
						snapshot: () => ({
							revision: 0,
							// This isolated test has no host compactor; preflight still requires its tool.
							factory: () => (pi) =>
								pi.registerTool({
									name: "compact_session",
									label: "compact_session",
									description: "Test compactor registration.",
									parameters: Type.Object({}),
									execute: async () => {
										throw new Error("not scripted");
									},
								}),
						}),
					},
				],
				toolTiers: MEMORY_TIERS,
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
	return {
		/** A turn of the speaker's in the channel: shared, or private to them, of the kind given. */
		run: (
			speaker: Speaker,
			channel = "fake:study",
			options: { private?: boolean; kind?: string } = {},
		) =>
			harness.turns.run({
				channel: channel as `fake:${string}`,
				kind: options.kind ?? "study",
				text: "Remember that I like algebra.",
				speaker,
				selection: {
					id: "study",
					tools: ["memory_add", "memory_search", "memory_remove"],
					groups: [],
				},
				...(options.private
					? { conversation: { visibility: "private" as const } }
					: {}),
			}),
		stop: () => harness.stop(),
	};
}

describe("memory in a persona conversation", () => {
	test("a member's turn carries the member's memory, never the owner's, and the tools change only the member's", async () => {
		const { store, writes, reads } = memoryOf({
			owner: ["Riley's bank PIN hint is the cat's name"],
			"member-7": ["Ada studies for the finals"],
		});
		let prompt = "";
		let found = "";
		const room = await studyRoom(store, [
			(context) => {
				prompt = systemOf(context);
				return call("memory_add", { fact: "Ada likes algebra", kind: "core" });
			},
			() => call("memory_search", { query: "PIN" }),
			(context) => {
				found = toolText(context);
				return fauxAssistantMessage("Noted.");
			},
		]);
		try {
			expect((await room.run(MEMBER)).ok).toBe(true);
			expect(prompt).toContain("You are a tutor.");
			expect(prompt).toContain("## Memory of Ada");
			expect(prompt).toContain("Ada studies for the finals");
			expect(prompt).not.toContain("bank PIN");
			expect(prompt).not.toContain("## Owner memory");
			expect(writes).toEqual([
				{ speaker: "member-7", fact: "Ada likes algebra" },
			]);
			expect(found).toBe('Nothing remembered matches "PIN".');
			expect(reads).not.toContain("owner");
		} finally {
			await room.stop();
		}
	});

	test("an admin's turn is theirs too", async () => {
		const { store, writes } = memoryOf({
			owner: ["Riley's bank PIN hint is the cat's name"],
		});
		let prompt = "";
		const room = await studyRoom(store, [
			(context) => {
				prompt = systemOf(context);
				return call("memory_add", { fact: "Kai teaches", kind: "core" });
			},
			fauxAssistantMessage("Noted."),
		]);
		try {
			expect((await room.run(ADMIN)).ok).toBe(true);
			expect(prompt).toContain("## Memory of Kai");
			expect(prompt).not.toContain("bank PIN");
			expect(writes).toEqual([{ speaker: "admin-3", fact: "Kai teaches" }]);
		} finally {
			await room.stop();
		}
	});

	test("the owner's private conversation keeps the owner memory and the owner's words", async () => {
		const { store, writes } = memoryOf({
			owner: ["Riley drinks oolong tea"],
		});
		let prompt = "";
		const room = await studyRoom(store, [
			(context) => {
				prompt = systemOf(context);
				return call("memory_add", {
					fact: "Riley likes algebra",
					kind: "core",
				});
			},
			fauxAssistantMessage("Noted."),
		]);
		try {
			expect(
				(await room.run(OWNER_SPEAKER, "fake:riley", { private: true })).ok,
			).toBe(true);
			expect(prompt).toContain("## Owner memory");
			expect(prompt).toContain("Riley drinks oolong tea");
			expect(prompt).not.toContain("## Memory of");
			// The tools keep the owner's words, exactly as before.
			expect(prompt).toContain(
				"Remember one fact about Riley for future conversations, when he asks you to",
			);
			expect(prompt).not.toContain("Whoever is speaking");
			expect(writes).toEqual([
				{ speaker: "owner", fact: "Riley likes algebra" },
			]);
		} finally {
			await room.stop();
		}
	});

	test("in a shared conversation the owner's turn reads the owner memory, and the tools name the speaker", async () => {
		const { store } = memoryOf({ owner: ["Riley drinks oolong tea"] });
		let prompt = "";
		const room = await studyRoom(store, [
			(context) => {
				prompt = systemOf(context);
				return fauxAssistantMessage("Noted.");
			},
		]);
		try {
			expect((await room.run(OWNER_SPEAKER)).ok).toBe(true);
			expect(prompt).toContain("## Owner memory");
			expect(prompt).toContain("Riley drinks oolong tea");
			expect(prompt).toContain(
				"Remember one fact about the speaker for future conversations",
			);
			expect(prompt).toContain("Whoever is speaking has a memory of their own");
		} finally {
			await room.stop();
		}
	});

	test("two people's private conversations each carry only their own memory, and memory_add writes their own", async () => {
		const { store, writes } = memoryOf({
			owner: ["Riley's bank PIN hint is the cat's name"],
			"member-7": ["Ada studies for the finals"],
			"admin-3": ["Kai teaches algebra"],
		});
		const prompts: string[] = [];
		const turn = (fact: string): FauxResponseStep[] => [
			(context) => {
				prompts.push(systemOf(context));
				return call("memory_add", { fact, kind: "core" });
			},
			fauxAssistantMessage("Noted."),
		];
		const room = await studyRoom(store, [
			...turn("Ada likes algebra"),
			...turn("Kai likes geometry"),
		]);
		try {
			expect((await room.run(MEMBER, "fake:ada", { private: true })).ok).toBe(
				true,
			);
			expect((await room.run(ADMIN, "fake:kai", { private: true })).ok).toBe(
				true,
			);
			const [ada = "", kai = ""] = prompts;
			expect(ada).toContain("Ada studies for the finals");
			expect(ada).not.toContain("Kai teaches");
			expect(ada).not.toContain("bank PIN");
			expect(kai).toContain("Kai teaches algebra");
			expect(kai).not.toContain("Ada studies");
			expect(kai).not.toContain("bank PIN");
			expect(writes).toEqual([
				{ speaker: "member-7", fact: "Ada likes algebra" },
				{ speaker: "admin-3", fact: "Kai likes geometry" },
			]);
		} finally {
			await room.stop();
		}
	});

	test("a second owner, and a web user at the owner tier, read and change their own memory, never the primary owner's", async () => {
		const { store, writes } = memoryOf({
			owner: ["Riley's bank PIN hint is the cat's name"],
			bo: ["Bo runs the night shift"],
			"oidc:aXNz:sam": ["Sam plans a trip"],
		});
		const prompts: string[] = [];
		const turn = (fact: string): FauxResponseStep[] => [
			(context) => {
				prompts.push(systemOf(context));
				return call("memory_add", { fact, kind: "core" });
			},
			fauxAssistantMessage("Noted."),
		];
		const room = await studyRoom(store, [
			...turn("Bo likes tea"),
			...turn("Bo likes coffee"),
			...turn("Sam likes trains"),
		]);
		const bo: Speaker = {
			id: "bo-discord",
			name: "Bo",
			tier: "owner",
			principalId: "bo",
		};
		const sam: Speaker = {
			id: "oidc:aXNz:sam",
			name: "Sam",
			tier: "owner",
			principalId: "oidc:aXNz:sam",
		};
		try {
			expect((await room.run(bo, "fake:room")).ok).toBe(true);
			expect((await room.run(bo, "fake:bo", { private: true })).ok).toBe(true);
			expect((await room.run(sam, "fake:sam", { private: true })).ok).toBe(
				true,
			);
			const [shared = "", own = "", web = ""] = prompts;
			for (const prompt of [shared, own])
				expect(prompt).toContain("Bo runs the night shift");
			expect(web).toContain("Sam plans a trip");
			for (const prompt of prompts) {
				expect(prompt).not.toContain("bank PIN");
				expect(prompt).not.toContain("## Owner memory");
			}
			expect(writes).toEqual([
				{ speaker: "bo", fact: "Bo likes tea" },
				{ speaker: "bo", fact: "Bo likes coffee" },
				{ speaker: "oidc:aXNz:sam", fact: "Sam likes trains" },
			]);
		} finally {
			await room.stop();
		}
	});

	test("the owner's principal under another surface id, as remote MCP's turns are, keeps the owner memory", async () => {
		const { store, writes } = memoryOf({ owner: ["Riley drinks oolong tea"] });
		let prompt = "";
		const room = await studyRoom(store, [
			(context) => {
				prompt = systemOf(context);
				return call("memory_add", {
					fact: "Riley likes algebra",
					kind: "core",
				});
			},
			fauxAssistantMessage("Noted."),
		]);
		try {
			const remote: Speaker = {
				id: "remote-mcp",
				name: OWNER.name,
				tier: "owner",
				principalId: OWNER.id,
			};
			expect((await room.run(remote, "fake:mcp-1", { private: true })).ok).toBe(
				true,
			);
			expect(prompt).toContain("## Owner memory");
			expect(prompt).toContain("Riley drinks oolong tea");
			expect(writes).toEqual([
				{ speaker: "owner", fact: "Riley likes algebra" },
			]);
		} finally {
			await room.stop();
		}
	});

	test("the host's own turn in a shared conversation reads no one's memory; in a private one, its person's", async () => {
		const { store, reads } = memoryOf({
			owner: ["Riley drinks oolong tea"],
			"member-7": ["Ada studies for the finals"],
		});
		const prompts: string[] = [];
		const look: FauxResponseStep = (context) => {
			prompts.push(systemOf(context));
			return fauxAssistantMessage("Noted.");
		};
		const room = await studyRoom(store, [look, look, look]);
		const system: Speaker = {
			id: "assistant",
			name: "Assistant",
			tier: "owner",
			principalId: "system",
		};
		try {
			expect((await room.run(MEMBER, "fake:ada", { private: true })).ok).toBe(
				true,
			);
			expect((await room.run(system, "fake:ada")).ok).toBe(true);
			expect((await room.run(system, "fake:room")).ok).toBe(true);
			const [, own = "", shared = ""] = prompts;
			expect(own).toContain("Ada studies for the finals");
			expect(shared).not.toContain("## Owner memory");
			expect(shared).not.toContain("## Memory of");
			expect(shared).not.toContain("Riley drinks");
			expect(reads).not.toContain("system");
			expect(reads).not.toContain("assistant");
		} finally {
			await room.stop();
		}
	});

	test("a persona with memory none loads no memory: no section and no tools", async () => {
		const { store, reads } = memoryOf({ owner: ["Riley drinks oolong tea"] });
		let request: TranscriptContext | undefined;
		const room = await studyRoom(store, [
			(context) => {
				request = context;
				return fauxAssistantMessage("Hi.");
			},
		]);
		try {
			expect(
				(
					await room.run(OWNER_SPEAKER, "fake:quiz", {
						private: true,
						kind: "quiz",
					})
				).ok,
			).toBe(true);
			const prompt = request ? systemOf(request) : "";
			expect(prompt).toContain("You ask questions.");
			expect(prompt).not.toContain("## Owner memory");
			expect(prompt).not.toContain("memory_add");
			expect(reads).toEqual([]);
		} finally {
			await room.stop();
		}
	});
});
