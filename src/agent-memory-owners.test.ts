import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createFauxCore,
	type FauxResponseStep,
	fauxAssistantMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MEMORY_TIERS, memorySessionTool } from "./core/builtin/stores.ts";
import type { AgentSessions } from "./core/contract/runtime.ts";
import { definePlugin } from "./core/define.ts";
import type {
	Memory,
	MemoryKind,
} from "./core/modules/memory/owner-memory-store.ts";
import { PiAgentRuntime } from "./core/runtime/pi-agent-runtime.ts";
import type { MemoryStore, SpeakerMemory } from "./core/services.ts";
import type { AgentTurnScope } from "./core/sessions.ts";
import type { Speaker } from "./core/speakers.ts";
import { testPlugin } from "./testing.ts";

// The agent server's memory option, end to end over the real Pi runtime: with "owners" a
// non-owner speaker's turn in an agent's channel loads no memory, so it never carries private
// memory into the conversation's history, which claude-bridge's reader record would later hold
// against the owner.

const OWNER = {
	id: "owner",
	name: "Riley",
	pronouns: { subject: "he", object: "him", possessive: "his" },
} as const;
const OWNER_SPEAKER: Speaker = {
	id: "owner-1",
	name: "Riley",
	tier: "owner",
	principalId: OWNER.id,
};
const MEMBER: Speaker = {
	id: "ann-1",
	name: "Ann",
	tier: "member",
	principalId: "ann",
};
const SYSTEM: Speaker = {
	id: "assistant",
	name: "Assistant",
	tier: "owner",
	principalId: "system",
};
const OWNER_FACT = "OWNER_FACT_SECRET is the owner's locker code";
const MEMBER_FACT = "MEMBER_FACT_SECRET is Ann's locker code";
const AGENT: AgentTurnScope = {
	name: "infra",
	session: "fake:infra",
	home: "fake:infra",
};
const MEMORY_TOOL_NAMES = ["memory_add", "memory_search", "memory_remove"];

function memoryOf(facts: Record<string, string>): MemoryStore {
	const speaker = (id: string): SpeakerMemory => {
		const rows: Memory[] = facts[id]
			? [{ id: 1, kind: "core", fact: facts[id], eventDate: null }]
			: [];
		return {
			list: async () => rows,
			forPrompt: async () => ({ core: rows, events: [] }),
			add: async (fact: string, kind: MemoryKind = "core") => ({
				id: 2,
				kind,
				fact,
				eventDate: null,
			}),
			search: async () => rows,
			update: async () => undefined,
			removeById: async () => false,
			remove: async () => [],
		};
	};
	return { forSpeaker: speaker };
}

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A Pi runtime whose agent `infra` runs on `provider`, over a faux model; `memory` is the agent server's option. */
async function host(
	steps: FauxResponseStep[],
	options: { provider: string; memory?: AgentSessions["memory"] },
) {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-agent-memory-"));
	dirs.push(dir);
	const { provider } = options;
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
	const store = memoryOf({ owner: OWNER_FACT, ann: MEMBER_FACT });
	const harness = await testPlugin(
		definePlugin({
			name: "agent-memory",
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
						logger: deps.logger,
						confirmations: deps.confirmations,
						toolTiers: deps.toolTiers,
						agents: {
							workDir: dir,
							skills: () => [],
							modelOf: () => ({ model: `${provider}/faux-1`, thinking: "off" }),
							turnChannel: (scope) => scope.home,
							...(options.memory ? { memory: options.memory } : {}),
						},
					}),
			},
			setup: () => ({
				sessionTools: [
					memorySessionTool(store, OWNER),
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
	const { runtime } = harness;
	if (!runtime) throw new Error("the plugin fills the runtime slot");
	const seen: TranscriptContext[] = [];
	return {
		seen,
		pending: () => core.getPendingResponseCount(),
		stop: () => harness.stop(),
		run: (speaker: Speaker) =>
			runtime.runTurn({
				channel: AGENT.home,
				selection: { id: "agent", tools: MEMORY_TOOL_NAMES, groups: [] },
				text: "Hello.",
				speaker,
				agent: AGENT,
			}),
	};
}

/** A step that records the request it answers. */
function look(seen: TranscriptContext[]): FauxResponseStep {
	return (context) => {
		seen.push(context);
		return fauxAssistantMessage("OK.");
	};
}

/** Whether the request, whose system messages declare its tools, names the tool. */
const declares = (context: TranscriptContext, tool: string) =>
	JSON.stringify(context).includes(`"${tool}"`);

describe("the agent server's memory option", () => {
	test("owners: a member's turn carries no memory block and no memory tools; the owner's still does", async () => {
		const seen: TranscriptContext[] = [];
		const h = await host([look(seen), look(seen), look(seen)], {
			provider: "faux",
			memory: "owners",
		});
		try {
			expect((await h.run(MEMBER)).ok).toBe(true);
			expect((await h.run(OWNER_SPEAKER)).ok).toBe(true);
			expect((await h.run(MEMBER)).ok).toBe(true);
			const [first, owner, again] = seen;
			if (!first || !owner || !again) throw new Error("a turn asked nothing");
			for (const member of [first, again]) {
				const sent = JSON.stringify(member);
				expect(sent).not.toContain("MEMBER_FACT_SECRET");
				expect(sent).not.toContain("OWNER_FACT_SECRET");
				for (const name of MEMORY_TOOL_NAMES)
					expect(declares(member, name)).toBe(false);
			}
			expect(JSON.stringify(owner)).toContain("OWNER_FACT_SECRET");
			for (const name of MEMORY_TOOL_NAMES)
				expect(declares(owner, name)).toBe(true);
		} finally {
			await h.stop();
		}
	});

	test("everyone, and the option left out: a member's turn reads their own memory, as before", async () => {
		for (const memory of [undefined, "everyone"] as const) {
			const seen: TranscriptContext[] = [];
			const h = await host([look(seen)], {
				provider: "faux",
				...(memory ? { memory } : {}),
			});
			try {
				expect((await h.run(MEMBER)).ok).toBe(true);
				const [member] = seen;
				if (!member) throw new Error("the turn asked nothing");
				expect(JSON.stringify(member)).toContain("MEMBER_FACT_SECRET");
				for (const name of MEMORY_TOOL_NAMES)
					expect(declares(member, name)).toBe(true);
			} finally {
				await h.stop();
			}
		}
	});

	test("owners, on claude-bridge: owner, then SYSTEM, then owner run after a member spoke", async () => {
		const h = await host(
			[
				fauxAssistantMessage("OK."),
				fauxAssistantMessage("OK."),
				fauxAssistantMessage("OK."),
				fauxAssistantMessage("OK."),
			],
			{ provider: "claude-bridge", memory: "owners" },
		);
		try {
			expect((await h.run(MEMBER)).ok).toBe(true);
			expect((await h.run(OWNER_SPEAKER)).ok).toBe(true);
			expect((await h.run(SYSTEM)).ok).toBe(true);
			expect((await h.run(OWNER_SPEAKER)).ok).toBe(true);
			expect(h.pending()).toBe(0);
		} finally {
			await h.stop();
		}
	});

	test("the default, on claude-bridge: a member's memory turn still refuses the owner afterwards", async () => {
		const h = await host(
			[fauxAssistantMessage("OK."), fauxAssistantMessage("unused")],
			{ provider: "claude-bridge" },
		);
		try {
			expect((await h.run(MEMBER)).ok).toBe(true);
			expect((await h.run(OWNER_SPEAKER)).ok).toBe(false);
			expect(h.pending()).toBe(1);
		} finally {
			await h.stop();
		}
	});

	test("owners, on claude-bridge: a member is still refused once the owner's memory is in the history", async () => {
		const h = await host(
			[fauxAssistantMessage("OK."), fauxAssistantMessage("unused")],
			{ provider: "claude-bridge", memory: "owners" },
		);
		try {
			expect((await h.run(OWNER_SPEAKER)).ok).toBe(true);
			expect((await h.run(MEMBER)).ok).toBe(false);
			expect(h.pending()).toBe(1);
		} finally {
			await h.stop();
		}
	});
});
