import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createFauxCore,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { definePlugin, defineTool } from "./core/define.ts";
import type { TurnProgressEvent } from "./core/plugin.ts";
import { PiAgentRuntime } from "./core/runtime/pi-agent-runtime.ts";
import { OWNER_SPEAKER, testPlugin } from "./testing.ts";

/** A real Pi turn on a surface that records the progress it is shown, and a plugin that hears it. */
async function fixture(steps: FauxResponseStep[]) {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-progress-"));
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
	const log: string[] = [];
	const heard: TurnProgressEvent[] = [];
	const harness = await testPlugin(
		definePlugin({
			name: "progress",
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
					}),
			},
			setup: () => ({
				events: {
					turnProgress: (event) => void heard.push(event),
				},
				tools: [
					defineTool({
						name: "probe",
						description: "Look something up.",
						parameters: Type.Object({}),
						minTier: "member",
						run: () => {
							log.push("tool probe");
							return "found";
						},
					}),
				],
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
					sendReply: async () => void log.push("reply"),
					progress: (_channel, event) =>
						void log.push(
							event.type === "text"
								? `text ${event.delta}`
								: event.type === "tool_start"
									? `start ${event.tool} ${event.preview ?? ""}`
									: `end ${event.tool} ${event.ok}`,
						),
				},
			],
		},
	);
	return {
		log,
		heard,
		run: () =>
			harness.turns.run({
				channel: "fake:room",
				kind: "owner",
				text: "make an NPC",
				speaker: OWNER_SPEAKER,
				selection: { id: "progress", tools: ["probe"], groups: [] },
			}),
		close: async () => {
			await harness.stop();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("a Pi turn reports its text and its tools as it goes, the thinking and the arguments' full text never", async () => {
	const secret = "s".repeat(400);
	const f = await fixture([
		fauxAssistantMessage(
			[
				fauxThinking("private reasoning"),
				fauxText("Checking the notes."),
				fauxToolCall("probe", { query: secret }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage([fauxText("Done: the innkeeper is in.")]),
	]);
	try {
		expect(await f.run()).toMatchObject({
			ok: true,
			text: "Done: the innkeeper is in.",
		});
		const shown = f.log.filter((line) => line !== "tool probe");
		expect(shown[0]).toBe("text Checking the notes.");
		expect(shown[1]).toStartWith('start probe {"query":"sss');
		expect(shown[1]?.length).toBeLessThan(140);
		expect(shown.slice(2)).toEqual([
			"end probe true",
			"text Done: the innkeeper is in.",
			"reply",
		]);
		expect(f.log.join("\n")).not.toContain("private reasoning");
		expect(
			f.log.findIndex((line) => line.startsWith("start probe")),
		).toBeLessThan(f.log.indexOf("tool probe"));
		expect(f.heard.map((event) => event.progress.type)).toEqual([
			"text",
			"tool_start",
			"tool_end",
			"text",
		]);
		expect(f.heard[0]).toMatchObject({
			kind: "owner",
			channel: "fake:room",
			speaker: OWNER_SPEAKER,
		});
	} finally {
		await f.close();
	}
});
