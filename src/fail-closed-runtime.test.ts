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
import { AgentRunError } from "./core/domain/errors.ts";
import type { TurnRequest } from "./core/domain/ports.ts";
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
async function probeHost(responses: ReturnType<typeof fauxAssistantMessage>[]) {
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
						toolTiers: deps.toolTiers,
						logger: deps.logger,
						confirmations: deps.confirmations,
						agents: {
							workDir: dir,
							skills: () => [],
							modelOf: () => ({ model: "faux/faux-1", thinking: "off" }),
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
