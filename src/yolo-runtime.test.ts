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
import type { ChannelKey, TurnResult } from "./core/domain/conversation.ts";
import { SYSTEM_PRINCIPAL } from "./core/identity/principal-store.ts";
import type { Approval, Prompts } from "./core/interactions/prompts.ts";
import type { AutoApproval } from "./core/modes/conversation-modes.ts";
import { PiAgentRuntime } from "./core/runtime/pi-agent-runtime.ts";
import type { Speaker } from "./core/speakers.ts";
import { OWNER_SPEAKER, testPlugin } from "./testing.ts";

/**
 * A real Pi turn whose model calls `deploy_it`, a tool a hold rule keeps behind the owner's
 * approval, in a conversation whose yolo mode is `yolo`; the surface records each card.
 */
async function fixture(options: {
	yolo: boolean;
	card?: readonly string[];
	answer?: Approval;
	/** Whether the hold rule reports a class for its call; a rule that does not leaves it unclassed. */
	classed?: boolean;
	/** The conversation follows another's modes, as a temp knight's follows the one that made it. */
	inherited?: true;
}) {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-yolo-"));
	const core = createFauxCore({ provider: "faux", models: [{ id: "faux-1" }] });
	core.setResponses([
		fauxAssistantMessage([fauxToolCall("deploy_it", {})], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxText("done")]),
	]);
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
	let asked = 0;
	const prompts: Prompts = {
		confirm: async () => {
			asked++;
			return options.answer ?? "declined";
		},
		ask: async () => undefined,
	};
	const ran: (string | undefined)[] = [];
	const approvals: AutoApproval[] = [];
	const harness = await testPlugin(
		definePlugin({
			name: "yolo-runtime",
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
						modes: {
							peek: () => ({
								yolo: options.yolo,
								longRunning: false,
								...(options.inherited
									? {
											inheritedFrom: {
												channel: "fake:parent" as ChannelKey,
												name: "Parent",
											},
										}
									: {}),
							}),
							autoApproved: (entry) => void approvals.push(entry),
						},
						autonomy: {
							yolo: { allow: [], card: options.card ?? [] },
							longRunningMaxMs: 60_000,
						},
					}),
			},
			setup: () => ({
				holdRules: [
					{
						name: "deploy",
						describe: (tool: string) =>
							tool === "deploy_it" ? "deploy it" : undefined,
						...(options.classed === false
							? {}
							: { holdClasses: () => ["deploy.run"] }),
					},
				],
				sessionTools: [
					{
						name: "deploy",
						phase: "tools",
						snapshot: () => ({
							revision: 0,
							factory: () => (pi) => {
								pi.registerTool({
									name: "deploy_it",
									label: "deploy_it",
									description: "Deploys.",
									parameters: Type.Object({}),
									execute: async () => {
										ran.push("ran");
										return {
											content: [{ type: "text", text: "ok" }],
											details: {},
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
					prompts: () => prompts,
				},
			],
		},
	);
	return {
		ran,
		approvals,
		get asked() {
			return asked;
		},
		run: (speaker: Speaker = OWNER_SPEAKER): Promise<TurnResult> =>
			harness.turns.run({
				channel: "fake:room",
				kind: "owner",
				text: "deploy",
				speaker,
				selection: { id: "deploy", tools: ["deploy_it"], groups: [] },
				interactive: true,
			}),
		close: async () => {
			await harness.stop();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("in a yolo conversation an owner's held call runs without a card and is reported", async () => {
	const f = await fixture({ yolo: true });
	try {
		expect(await f.run()).toMatchObject({ ok: true, text: "done" });
		expect(f.ran).toEqual(["ran"]);
		expect(f.asked).toBe(0);
		expect(f.approvals).toHaveLength(1);
		expect(f.approvals[0]).toMatchObject({
			channel: "fake:room",
			tool: "deploy_it",
			action: "deploy it",
			classes: ["deploy.run"],
			principalId: OWNER_SPEAKER.principalId,
		});
	} finally {
		await f.close();
	}
});

test("a temp knight's conversation approves by its parent's yolo, and the approval names the temp knight's own conversation", async () => {
	const f = await fixture({ yolo: true, inherited: true });
	try {
		expect(await f.run()).toMatchObject({ ok: true, text: "done" });
		expect(f.ran).toEqual(["ran"]);
		expect(f.asked).toBe(0);
		expect(f.approvals.map((entry) => entry.channel)).toEqual(["fake:room"]);
	} finally {
		await f.close();
	}
});

test("a rule that reports no classes leaves its call unclassed, so a yolo conversation asks on a card", async () => {
	const f = await fixture({ yolo: true, classed: false });
	try {
		expect(await f.run()).toMatchObject({ ok: true });
		expect(f.asked).toBe(1);
		expect(f.ran).toEqual([]);
		expect(f.approvals).toEqual([]);
	} finally {
		await f.close();
	}
});

test("without yolo the same call asks on a card, and runs only when it is approved", async () => {
	const f = await fixture({ yolo: false, answer: "approved" });
	try {
		expect(await f.run()).toMatchObject({ ok: true, text: "done" });
		expect(f.asked).toBe(1);
		expect(f.ran).toEqual(["ran"]);
		expect(f.approvals).toEqual([]);
	} finally {
		await f.close();
	}
});

test("a class the config cards asks on a card in a yolo conversation, and a declined call does not run", async () => {
	const f = await fixture({ yolo: true, card: ["deploy"] });
	try {
		expect(await f.run()).toMatchObject({ ok: true });
		expect(f.asked).toBe(1);
		expect(f.ran).toEqual([]);
		expect(f.approvals).toEqual([]);
	} finally {
		await f.close();
	}
});

test("a turn the host's own principal speaks asks on a card even in a yolo conversation", async () => {
	const f = await fixture({ yolo: true });
	try {
		await f.run({ ...OWNER_SPEAKER, principalId: SYSTEM_PRINCIPAL });
		expect(f.asked).toBe(1);
		expect(f.ran).toEqual([]);
		expect(f.approvals).toEqual([]);
	} finally {
		await f.close();
	}
});
