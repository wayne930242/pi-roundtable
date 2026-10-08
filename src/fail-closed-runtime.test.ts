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
import { AgentRunError } from "./core/domain/errors.ts";
import type { TurnConversation, TurnRequest } from "./core/domain/ports.ts";
import { PiAgentRuntime } from "./core/runtime/pi-agent-runtime.ts";
import type { SessionContext } from "./core/sessions.ts";
import type { Speaker } from "./core/speakers.ts";
import { testPlugin } from "./testing.ts";

const MEMBER: Speaker = {
	id: "7",
	name: "Sam",
	tier: "member",
	principalId: "p_sam",
};

const SELECTION = { id: "probe", tools: ["probe_task"], groups: [] };

/**
 * A Pi runtime on a faux model whose turns call `probe_task`, a session tool that records whom
 * its session's turn is for and runs a task beside it; agent turns run with a stand-in team.
 */
async function probeHost(
	responses: FauxResponseStep[],
	/** The host's record of each conversation, read when a session is made and the turn names none. */
	recorded?: TurnConversation,
	/** The agents' model, and why the host refuses claude-bridge, if it does. */
	agentModel: { model: string; bridgeRefusal?: string } = {
		model: "faux/faux-1",
	},
) {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-fail-closed-"));
	const core = createFauxCore({ provider: "faux", models: [{ id: "faux-1" }] });
	core.setResponses(responses);
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
	const seen: { speaker: Speaker | undefined; task: string }[] = [];
	const sessions: SessionContext[] = [];
	const harness = await testPlugin(
		definePlugin({
			name: "probe",
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
						...(recorded ? { conversationOf: async () => recorded } : {}),
						toolTiers: deps.toolTiers,
						logger: deps.logger,
						confirmations: deps.confirmations,
						bridgeRefusal: async () => agentModel.bridgeRefusal,
						agents: {
							workDir: dir,
							skills: () => [],
							modelOf: () => ({ model: agentModel.model, thinking: "off" }),
							turnChannel: (scope) => (scope.group ? "fake:group" : scope.home),
						},
					}),
			},
			setup: () => ({
				personas: [{ kind: "helper", prompt: () => "Help the person." }],
				toolTiers: { probe_task: "member" },
				sessionTools: [
					{
						name: "probe",
						phase: "tools",
						snapshot: () => ({
							revision: 0,
							factory: (session) => (pi) => {
								sessions.push(session);
								pi.registerTool({
									name: "probe_task",
									label: "probe_task",
									description: "Run a task beside this conversation.",
									parameters: Type.Object({}),
									execute: async () => {
										const speaker = session.speaker();
										const task = await session
											.runTask({
												selection: { tools: [], groups: [] },
												text: "Look it up.",
												timeoutMs: 10_000,
												exclude: [],
											})
											.catch((error: unknown) => `refused: ${error}`);
										seen.push({ speaker, task });
										return {
											content: [{ type: "text", text: task }],
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
		runtime,
		seen,
		sessions,
		pending: () => core.getPendingResponseCount(),
		done: async () => {
			await harness.stop();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** A turn that calls `probe_task`, whose task the worker answers, then ends. */
const PROBE_TURN = () => [
	fauxAssistantMessage([fauxToolCall("probe_task", {})], {
		stopReason: "toolUse",
	}),
	fauxAssistantMessage([fauxText("Found it.")]),
	fauxAssistantMessage([fauxText("Done.")]),
];

test("a turn without a speaker is refused before the model is asked, naming the fix", async () => {
	const host = await probeHost(PROBE_TURN());
	try {
		// SAFETY: the request lacks only `speaker`, as a caller outside TypeScript, or one that casts, sends it.
		const request = {
			channel: "fake:room",
			selection: SELECTION,
			text: "Hello.",
			kind: "helper",
		} as unknown as TurnRequest;
		const result = await host.runtime.runTurn(request);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBeInstanceOf(AgentRunError);
		expect(result.error.message).toContain("TurnRequest.speaker");
		expect(result.error.message).toContain("IDENTITY.speakerFor");
		expect(host.pending()).toBe(3);
		expect(host.seen).toEqual([]);
	} finally {
		await host.done();
	}
});

test("a task beside a group seat's turn runs as that turn's speaker, whose tier it takes", async () => {
	const host = await probeHost(PROBE_TURN());
	try {
		const result = await host.runtime.runTurn({
			channel: "fake:group",
			selection: SELECTION,
			text: "Look it up.",
			speaker: MEMBER,
			agent: {
				name: "infra",
				session: "fake:group#infra",
				home: "fake:infra",
				group: "ops",
			},
		});
		expect(result).toEqual({ ok: true, text: "Done." });
		expect(host.seen).toEqual([{ speaker: MEMBER, task: "Found it." }]);
	} finally {
		await host.done();
	}
});

test("a task beside a group seat's turn works in the agent's own conversation, for the seat turn's speaker", async () => {
	let worker: { home: string; speaker: Speaker | undefined } | undefined;
	let host: Awaited<ReturnType<typeof probeHost>> | undefined;
	host = await probeHost([
		fauxAssistantMessage([fauxToolCall("probe_task", {})], {
			stopReason: "toolUse",
		}),
		// The worker's answer, read while its session is the newest and its task runs.
		() => {
			const session = host?.sessions.at(-1);
			worker = session && {
				home: session.homeChannel,
				speaker: session.speaker(),
			};
			return fauxAssistantMessage([fauxText("Found it.")]);
		},
		fauxAssistantMessage([fauxText("Done.")]),
	]);
	try {
		await host.runtime.runTurn({
			channel: "fake:group",
			selection: SELECTION,
			text: "Look it up.",
			speaker: MEMBER,
			agent: {
				name: "infra",
				session: "fake:group#infra",
				home: "fake:infra",
				group: "ops",
			},
		});
		const seat = host.sessions.find((session) => session.agent);
		// Its home is the seat session's, which a surface carries, not the seat's key, which none does.
		expect(worker).toEqual({ home: seat?.homeChannel ?? "", speaker: MEMBER });
		expect(worker?.home).not.toBe("fake:group#infra");
	} finally {
		await host.done();
	}
});

test("a task asked for between turns, with no turn to take its tier from, is refused", async () => {
	// One more answer, which a worker given the owner's tier, as 0.8 gave it, would take.
	const host = await probeHost([
		...PROBE_TURN(),
		fauxAssistantMessage([fauxText("Found it again.")]),
	]);
	try {
		await host.runtime.runTurn({
			channel: "fake:room",
			selection: SELECTION,
			text: "Look it up.",
			kind: "helper",
			speaker: MEMBER,
		});
		const session = host.sessions.find((s) => s.homeChannel === "fake:room");
		if (!session) throw new Error("the conversation's session was not made");
		expect(session.speaker()).toBeUndefined();
		const late = session.runTask({
			selection: { tools: [], groups: [] },
			text: "Again.",
			timeoutMs: 10_000,
			exclude: [],
		});
		expect(late).rejects.toBeInstanceOf(AgentRunError);
		expect(await late.catch((error: Error) => error.message)).toContain(
			"no turn",
		);
		expect(host.pending()).toBe(1);
	} finally {
		await host.done();
	}
});

test("in a private conversation, another principal's turn is refused before the model is asked; its person's and the host's run", async () => {
	const host = await probeHost([
		fauxAssistantMessage([fauxText("Hi, Sam.")]),
		fauxAssistantMessage([fauxText("Report noted.")]),
	]);
	const conversation = { visibility: "private", principalId: "p_sam" } as const;
	const turn = (speaker: Speaker) =>
		host.runtime.runTurn({
			channel: "fake:sam",
			selection: SELECTION,
			text: "Hello.",
			kind: "helper",
			speaker,
			conversation,
		});
	try {
		const other = await turn({
			...MEMBER,
			principalId: "p_ann",
			tier: "owner",
		});
		expect(other.ok).toBe(false);
		if (!other.ok) expect(other.error.message).toContain("private to p_sam");
		expect(host.pending()).toBe(2);
		expect((await turn(MEMBER)).ok).toBe(true);
		const system = {
			id: "assistant",
			name: "Assistant",
			tier: "owner",
			principalId: "system",
		} as const;
		expect((await turn(system)).ok).toBe(true);
	} finally {
		await host.done();
	}
});

test("a session the turn names no conversation for is as the host recorded it, and a turn naming another rebuilds it", async () => {
	const host = await probeHost(
		[
			fauxAssistantMessage([fauxText("One.")]),
			fauxAssistantMessage([fauxText("Two.")]),
		],
		{ visibility: "private", principalId: "p_sam" },
	);
	const turn = (conversation?: TurnConversation) =>
		host.runtime.runTurn({
			channel: "fake:sam",
			selection: SELECTION,
			text: "Hello.",
			kind: "helper",
			speaker: MEMBER,
			...(conversation ? { conversation } : {}),
		});
	try {
		expect((await turn()).ok).toBe(true);
		expect((await turn({ visibility: "shared" })).ok).toBe(true);
		const made = host.sessions.filter((s) => s.homeChannel === "fake:sam");
		expect(made.map((session) => session.conversation)).toEqual([
			{ visibility: "private", principalId: "p_sam" },
			{ visibility: "shared" },
		]);
		// A private conversation of someone the host knows nothing of addresses the speaker.
		expect(made[0]?.addressee.name).toBe("the speaker");
	} finally {
		await host.done();
	}
});

test("a task works for whom its turn's conversation serves", async () => {
	let worker: SessionContext["conversation"] | undefined;
	let host: Awaited<ReturnType<typeof probeHost>> | undefined;
	host = await probeHost([
		fauxAssistantMessage([fauxToolCall("probe_task", {})], {
			stopReason: "toolUse",
		}),
		() => {
			worker = host?.sessions.at(-1)?.conversation;
			return fauxAssistantMessage([fauxText("Found it.")]);
		},
		fauxAssistantMessage([fauxText("Done.")]),
	]);
	try {
		await host.runtime.runTurn({
			channel: "fake:sam",
			selection: SELECTION,
			text: "Look it up.",
			kind: "helper",
			speaker: MEMBER,
			conversation: { visibility: "private", principalId: "p_sam" },
		});
		expect(worker).toEqual({ visibility: "private", principalId: "p_sam" });
	} finally {
		await host.done();
	}
});

test("an agent on claude-bridge is refused before its turn when the host's shared conversations hold several people's memory", async () => {
	const host = await probeHost(PROBE_TURN(), undefined, {
		model: "claude-bridge/claude-opus-5-5",
		bridgeRefusal: "access.members admits people besides the owner",
	});
	try {
		const refused = await host.runtime.runTurn({
			channel: "fake:infra",
			selection: SELECTION,
			text: "Look it up.",
			speaker: MEMBER,
			agent: { name: "infra", session: "fake:infra", home: "fake:infra" },
		});
		expect(refused.ok).toBe(false);
		if (!refused.ok)
			expect(refused.error.message).toMatch(
				/^infra: .*claude-bridge.*private memory/s,
			);
		expect(host.pending()).toBe(3);
	} finally {
		await host.done();
	}
});
