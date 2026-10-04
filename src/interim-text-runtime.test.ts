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
import type { OutboundReply } from "./core/domain/conversation.ts";
import type { InterimTextMode } from "./core/domain/interim.ts";
import { PiAgentRuntime } from "./core/runtime/pi-agent-runtime.ts";
import { OWNER_SPEAKER, testPlugin } from "./testing.ts";

const PROPOSAL = `## The NPC\n${"A tired innkeeper who knows more than she says. ".repeat(12)}`;

/** A tool-calling assistant message with text before its call. */
const say = (
	text: string,
	tool: string,
	args: Parameters<typeof fauxToolCall>[1] = {},
) =>
	fauxAssistantMessage([fauxText(text), fauxToolCall(tool, args)], {
		stopReason: "toolUse",
	});

/** A real Pi turn on a surface that logs its interim posts, cards, tools, and final reply in order. */
async function fixture(
	steps: FauxResponseStep[],
	interimText: InterimTextMode = "on",
) {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-interim-"));
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
	const replies: OutboundReply[] = [];
	const shown: string[] = [];
	const harness = await testPlugin(
		definePlugin({
			name: "interim",
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
						interimText,
					}),
			},
			setup: () => ({
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
					sendReply: async (_channel, reply) => {
						log.push("reply");
						replies.push(reply);
					},
					prompts: () => ({
						confirm: async () => "approved",
						ask: async (_title, question) => {
							log.push(`card ${question.question}`);
							return { choices: ["yes"] };
						},
					}),
					interim: () => ({
						post: async (text) => {
							const index = shown.push(text) - 1;
							log.push(`post ${index}`);
							return {
								edit: async (change) => {
									shown[index] = change;
									log.push(`edit ${index}`);
								},
							};
						},
					}),
				},
			],
		},
	);
	return {
		log,
		replies,
		shown,
		run: () =>
			harness.turns.run({
				channel: "fake:room",
				kind: "owner",
				text: "make an NPC",
				speaker: OWNER_SPEAKER,
				interactive: true,
				selection: {
					id: "interim",
					tools: ["probe", "ask_user"],
					groups: [],
				},
			}),
		close: async () => {
			await harness.stop();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

const final = fauxAssistantMessage([
	fauxThinking("weighing it"),
	fauxText("Done: the innkeeper is in."),
]);

test("a long proposal in a tool-calling message is posted before the next tool runs, and the final reply once", async () => {
	const f = await fixture([say(PROPOSAL, "probe"), final]);
	try {
		expect(await f.run()).toMatchObject({
			ok: true,
			text: "Done: the innkeeper is in.",
		});
		expect(f.shown[0]).toBe(PROPOSAL.trim());
		expect(f.log.indexOf("post 0")).toBeLessThan(f.log.indexOf("tool probe"));
		expect(f.log.at(-1)).toBe("reply");
		expect(f.replies).toEqual([
			{
				thinking: "-# weighing it",
				chunks: ["Done: the innkeeper is in."],
			},
		]);
		expect(f.shown.join("\n")).not.toContain("innkeeper is in");
	} finally {
		await f.close();
	}
});

test("the text written before ask_user is posted above its card", async () => {
	const f = await fixture([
		say("checking the notes", "probe"),
		say(PROPOSAL, "ask_user", { question: "Go with this version?" }),
		final,
	]);
	try {
		expect((await f.run()).ok).toBe(true);
		const card = f.log.indexOf("card Go with this version?");
		expect(card).toBeGreaterThan(-1);
		const proposal = f.shown.indexOf(PROPOSAL.trim());
		expect(f.log.indexOf(`post ${proposal}`)).toBeLessThan(card);
		// The progress message before the proposal holds the narration and its tool.
		expect(f.shown[0]).toBe("-# checking the notes\n-# probe");
		expect(f.log.indexOf("post 0")).toBeLessThan(card);
		expect(f.replies).toHaveLength(1);
	} finally {
		await f.close();
	}
});

test('interimText "off" posts only the final reply', async () => {
	const f = await fixture([say(PROPOSAL, "probe"), final], "off");
	try {
		expect((await f.run()).ok).toBe(true);
		expect(f.shown).toEqual([]);
		expect(f.log).toEqual(["tool probe", "reply"]);
	} finally {
		await f.close();
	}
});
