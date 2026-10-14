import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
import { ownerAttachmentDir } from "./core/attachments/attachment-dir.ts";
import { AttachmentStore } from "./core/attachments/attachment-store.ts";
import type { HeldActionStore, RuntimeDeps } from "./core/contract/runtime.ts";
import { definePlugin, defineTool } from "./core/define.ts";
import type {
	ChannelKey,
	PendingConfirmation,
} from "./core/domain/conversation.ts";
import type { TurnConversation } from "./core/domain/ports.ts";
import type { ApprovedBy } from "./core/interactions/prompts.ts";
import { silentLogger } from "./core/log.ts";
import { CONFIRMATION_TTL_MS } from "./core/runtime/extensions/confirmation-gate.ts";
import { PiAgentRuntime } from "./core/runtime/pi-agent-runtime.ts";
import type { AgentTurnScope } from "./core/sessions.ts";
import type { Speaker } from "./core/speakers.ts";
import { testPlugin } from "./testing.ts";

// A host restart, end to end over the real Pi runtime: held actions the store keeps are known to
// the first message after it, so a host that asks `pendingConfirmation` after reading the
// transcript, or `heldActions`, sees them and can approve them, as in 0.8.

const OWNER_SPEAKER: Speaker = {
	id: "owner-1",
	name: "Owner",
	tier: "owner",
	principalId: "owner",
};
const AGENT: AgentTurnScope = {
	name: "infra",
	session: "fake:infra",
	home: "fake:infra",
};
const TOOLS = ["deploy", "probe", "ship"];
const SAM: Speaker = {
	id: "7",
	name: "Sam",
	tier: "member",
	principalId: "p_sam",
};
const ADA: Speaker = {
	id: "9",
	name: "Ada",
	tier: "member",
	principalId: "p_ada",
};

/** A turn whose model calls `tool` once, then answers. */
const calling = (
	tool: string,
	input: Record<string, string>,
): FauxResponseStep[] => [
	fauxAssistantMessage([fauxToolCall(tool, input)], { stopReason: "toolUse" }),
	fauxAssistantMessage([fauxText("Done.")]),
];

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/**
 * A host whose runtime can be restarted: `restart()` makes a new runtime over the same held-action
 * store and session files, as a reboot does. `deploy` is held whatever the session; `probe` is held
 * only in a session with a shell workspace, the way an agent's is.
 */
async function host(responses: FauxResponseStep[]) {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-held-restart-"));
	dirs.push(dir);
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
	const ran = { deploy: 0, probe: 0, ship: [] as (ApprovedBy | undefined)[] };
	/** The signals the plugin withdraws a site's deploy by; a site without one is held by its text alone. */
	const withdrawals = new Map<string, AbortController>();
	let deps: RuntimeDeps | undefined;
	const build = (given: RuntimeDeps): PiAgentRuntime =>
		new PiAgentRuntime({
			owner: {
				...given.owner,
				pronouns: { subject: "they", object: "them", possessive: "their" },
			},
			agentDir: dir,
			dataDir: dir,
			modelRuntime,
			model: { provider: "faux", id: "faux-1" },
			thinking: "off",
			effort: { judge: async () => "off" },
			sessions: given.sessions,
			toolTiers: given.toolTiers,
			logger: given.logger,
			confirmations: given.confirmations,
			prompts: given.prompts,
			agents: {
				workDir: dir,
				skills: () => [],
				modelOf: () => ({ model: "faux/faux-1", thinking: "off" }),
				turnChannel: (scope) => scope.home,
			},
		});
	let current: PiAgentRuntime | undefined;
	const harness = await testPlugin(
		definePlugin({
			name: "held-restart",
			providers: {
				runtime: (given) => {
					deps = given;
					current = build(given);
					return current;
				},
			},
			setup: () => ({
				personas: [{ kind: "helper", prompt: () => "Help the person." }],
				holdRules: [
					{
						name: "workspace-probe",
						describe: (tool, _input, context) =>
							tool === "probe" && context.workspace !== undefined
								? "probe the workspace"
								: undefined,
					},
				],
				tools: [
					defineTool({
						name: "deploy",
						description: "Deploy a site.",
						parameters: Type.Object({ site: Type.String() }),
						minTier: "member",
						hold: ({ site }) => {
							const withdraw = withdrawals.get(site);
							return withdraw
								? { text: `deploy ${site}`, supersede: withdraw.signal }
								: `deploy ${site}`;
						},
						run: () => {
							ran.deploy += 1;
							return "deployed";
						},
					}),
					defineTool({
						name: "ship",
						description: "Ship it, approved by one of the people it names.",
						parameters: Type.Object({ to: Type.String() }),
						minTier: "member",
						hold: ({ to }) => `ship to ${to}`,
						approvers: async () => ["p_ada"],
						run: (_args, turn) => {
							ran.ship.push(turn.approvedBy);
							return "shipped";
						},
					}),
					defineTool({
						name: "probe",
						description: "Probe.",
						parameters: Type.Object({}),
						minTier: "member",
						run: () => {
							ran.probe += 1;
							return "probed";
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
					sendReply: async () => undefined,
				},
			],
		},
	);
	const live = (): PiAgentRuntime => {
		if (!current) throw new Error("the plugin fills the runtime slot");
		return current;
	};
	const store: HeldActionStore = {
		load: (channel) => {
			if (!deps) throw new Error("the plugin fills the runtime slot");
			return deps.confirmations.load(channel);
		},
		save: (channel, held) => {
			if (!deps) throw new Error("the plugin fills the runtime slot");
			return deps.confirmations.save(channel, held);
		},
	};
	return {
		dir,
		ran,
		withdrawals,
		store,
		core,
		runtime: live,
		/** A reboot: the old runtime is gone, a new one has only the store and the session files. */
		restart: () => {
			live().dispose();
			if (!deps) throw new Error("the plugin fills the runtime slot");
			current = build(deps);
			return current;
		},
		/** One turn of the owner on `channel` calling `tool`; `confirmed` as a host that approved it says. */
		turn: (
			channel: ChannelKey,
			text: string,
			options: {
				confirmed?: boolean;
				conversation?: TurnConversation;
				agent?: AgentTurnScope;
				speaker?: Speaker;
			} = {},
		) =>
			live().runTurn({
				channel,
				kind: "helper",
				text,
				speaker: options.speaker ?? OWNER_SPEAKER,
				selection: { id: "held", tools: TOOLS, groups: [] },
				...(options.confirmed ? { confirmed: true } : {}),
				...(options.conversation ? { conversation: options.conversation } : {}),
				...(options.agent ? { agent: options.agent } : {}),
			}),
		stop: () => harness.stop(),
	};
}

const PRIVATE: TurnConversation = {
	visibility: "private",
	principalId: "owner",
};
const SHARED: TurnConversation = { visibility: "shared" };

describe("held actions after a restart", () => {
	for (const [label, channel, conversation] of [
		["a private conversation", "fake:dm", PRIVATE],
		["a shared conversation", "fake:room", SHARED],
	] as const) {
		test(`${label}: the first message after the restart finds the held action, and its approval runs the call once`, async () => {
			const h = await host([
				...calling("deploy", { site: "docs" }),
				...calling("deploy", { site: "docs" }),
			]);
			try {
				expect(
					(await h.turn(channel, "deploy docs", { conversation })).ok,
				).toBe(true);
				expect(h.ran.deploy).toBe(0);
				expect(await h.store.load(channel)).toBeDefined();

				const runtime = h.restart();
				// A host reads the transcript to build its turn, then asks what is pending.
				await runtime.recentTranscript(channel, 5);
				const pending = runtime.pendingConfirmation(channel);
				expect(pending?.calls.map((call) => call.tool)).toEqual(["deploy"]);

				const approved = await h.turn(channel, "yes, go ahead", {
					conversation,
					confirmed: true,
				});
				expect(approved.ok).toBe(true);
				expect(h.ran.deploy).toBe(1);
				// The held row is consumed by the approval, once.
				expect(await h.store.load(channel)).toBeUndefined();
				expect(runtime.pendingConfirmation(channel)).toBeUndefined();
			} finally {
				await h.stop();
			}
		});
	}

	test("a plugin's withdrawal of a held call is saved: neither a message nor a restart brings it back", async () => {
		const h = await host([
			...calling("deploy", { site: "docs" }),
			...calling("deploy", { site: "docs" }),
		]);
		try {
			const withdraw = new AbortController();
			h.withdrawals.set("docs", withdraw);
			await h.turn("fake:room", "deploy docs", { conversation: SHARED });
			expect((await h.store.load("fake:room"))?.calls).toHaveLength(1);

			withdraw.abort("replaced by a newer request");
			await Bun.sleep(5);
			expect(await h.store.load("fake:room")).toBeUndefined();
			expect(h.runtime().pendingConfirmation("fake:room")).toBeUndefined();

			const runtime = h.restart();
			await runtime.recentTranscript("fake:room", 5);
			expect(runtime.pendingConfirmation("fake:room")).toBeUndefined();
			// The plugin holds a repeated call anew, with no signal of the old request.
			h.withdrawals.delete("docs");
			// The owner's yes releases nothing: the model's repeated call is held again.
			await h.turn("fake:room", "yes, go ahead", {
				conversation: SHARED,
				confirmed: true,
			});
			expect(h.ran.deploy).toBe(0);
			expect((await h.store.load("fake:room"))?.calls).toHaveLength(1);
		} finally {
			await h.stop();
		}
	});

	test("a withdrawal after a restart cannot reach the call: its signal did not survive, so the call stays held and confirmable", async () => {
		const h = await host([
			...calling("deploy", { site: "docs" }),
			...calling("deploy", { site: "docs" }),
		]);
		try {
			const withdraw = new AbortController();
			h.withdrawals.set("docs", withdraw);
			await h.turn("fake:room", "deploy docs", { conversation: SHARED });
			const runtime = h.restart();
			await runtime.recentTranscript("fake:room", 5);
			withdraw.abort();
			await Bun.sleep(5);
			// The old runtime's gate no longer touches what the store keeps for the new one.
			expect((await h.store.load("fake:room"))?.calls).toHaveLength(1);
			expect(runtime.pendingConfirmation("fake:room")?.calls).toHaveLength(1);
			// The plugin's hold decides anew when the call is repeated; here it gives no signal.
			h.withdrawals.delete("docs");
			await h.turn("fake:room", "yes", {
				conversation: SHARED,
				confirmed: true,
			});
			expect(h.ran.deploy).toBe(1);
		} finally {
			await h.stop();
		}
	});

	test("a hold that answers an aborted signal refuses a confirmed call, which is how it withdraws one a restart left held", async () => {
		const h = await host([
			...calling("deploy", { site: "docs" }),
			...calling("deploy", { site: "docs" }),
		]);
		try {
			await h.turn("fake:room", "deploy docs", { conversation: SHARED });
			h.restart();
			// After the restart the plugin finds the subject gone: its hold answers an aborted signal.
			const gone = new AbortController();
			gone.abort();
			h.withdrawals.set("docs", gone);
			await h.turn("fake:room", "yes, go ahead", {
				conversation: SHARED,
				confirmed: true,
			});
			expect(h.ran.deploy).toBe(0);
		} finally {
			await h.stop();
		}
	});

	test("the approvers a held call names survive a restart, and the person whose message confirms it is the approver its run sees", async () => {
		const h = await host([
			...calling("ship", { to: "acme" }),
			...calling("ship", { to: "acme" }),
		]);
		try {
			await h.turn("fake:room", "ship to acme", {
				conversation: SHARED,
				speaker: SAM,
			});
			expect(h.ran.ship).toEqual([]);
			expect((await h.store.load("fake:room"))?.calls[0]?.approverIds).toEqual([
				"p_ada",
			]);

			const runtime = h.restart();
			await runtime.recentTranscript("fake:room", 5);
			expect(
				runtime.pendingConfirmation("fake:room")?.calls[0]?.approverIds,
			).toEqual(["p_ada"]);

			await h.turn("fake:room", "yes, ship it", {
				conversation: SHARED,
				speaker: ADA,
				confirmed: true,
			});
			expect(h.ran.ship).toEqual([
				{ principalId: "p_ada", speakerId: "9", name: "Ada" },
			]);
		} finally {
			await h.stop();
		}
	});

	test("heldActions restores them too, and builds no gate in the agent flavour for an owner conversation", async () => {
		const h = await host([
			...calling("deploy", { site: "docs" }),
			...calling("probe", {}),
		]);
		try {
			await h.turn("fake:dm", "deploy docs", { conversation: PRIVATE });
			const runtime = h.restart();
			const held = await runtime.heldActions("fake:dm");
			expect(held?.calls.map((call) => call.tool)).toEqual(["deploy"]);
			expect(runtime.pendingConfirmation("fake:dm")).toEqual(held);
			// Not an agent's conversation: its shell-less session holds nothing for the workspace.
			await h.turn("fake:dm", "probe", { conversation: PRIVATE });
			expect(h.ran.probe).toBe(1);
		} finally {
			await h.stop();
		}
	});

	test("an agent conversation keeps its flavour: the workspace judgement holds its probe, and it restores after a restart", async () => {
		const h = await host([...calling("probe", {}), ...calling("probe", {})]);
		try {
			await h.turn(AGENT.home, "probe", { agent: AGENT });
			expect(h.ran.probe).toBe(0);
			const runtime = h.restart();
			const held = await runtime.heldActions(AGENT.session);
			expect(held?.calls.map((call) => call.tool)).toEqual(["probe"]);
			expect(runtime.pendingConfirmation(AGENT.session)).toEqual(held);
			await h.turn(AGENT.home, "yes", { agent: AGENT, confirmed: true });
			expect(h.ran.probe).toBe(1);
			expect(await h.store.load(AGENT.session)).toBeUndefined();
		} finally {
			await h.stop();
		}
	});

	test("deleting a conversation removes the files its turns used and the files waiting for it", async () => {
		const h = await host([]);
		try {
			const attachments = new AttachmentStore({
				dataDir: h.dir,
				registry: () => undefined,
				logger: silentLogger(),
			});
			const upload = (name: string) => ({
				name,
				contentType: "text/plain",
				data: new TextEncoder().encode("x"),
			});
			const used = await attachments.save("fake:dm", "owner", upload("a.txt"));
			await attachments.turnAttachments("fake:dm", "owner", [used.file]);
			const waiting = await attachments.save(
				"fake:dm",
				"owner",
				upload("b.txt"),
			);
			const other = await attachments.save(
				"fake:room",
				"owner",
				upload("c.txt"),
			);
			await h.runtime().deleteConversation("fake:dm");
			expect(existsSync(ownerAttachmentDir(h.dir, "fake:dm"))).toBe(false);
			expect(existsSync(waiting.path)).toBe(false);
			expect(existsSync(other.path)).toBe(true);
		} finally {
			await h.stop();
		}
	});

	test("held actions past the confirmation window are none after a restart", async () => {
		const h = await host([]);
		try {
			const old: PendingConfirmation = {
				selectionId: "held",
				heldAt: new Date(Date.now() - CONFIRMATION_TTL_MS - 60_000),
				calls: [
					{ tool: "deploy", input: '{"site":"docs"}', action: "deploy docs" },
				],
			};
			await h.store.save("fake:dm", old);
			const runtime = h.restart();
			await runtime.recentTranscript("fake:dm", 5);
			expect(runtime.pendingConfirmation("fake:dm")).toBeUndefined();
			expect(await runtime.heldActions("fake:dm")).toBeUndefined();
		} finally {
			await h.stop();
		}
	});
});
