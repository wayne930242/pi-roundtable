import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createFauxCore,
	fauxAssistantMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { definePlugin } from "./core/define.ts";
import { addresseeOf, type OwnerIdentity } from "./core/identity.ts";
import { notifyExtension } from "./core/modules/notify/notify.ts";
import { PiAgentRuntime } from "./core/runtime/pi-agent-runtime.ts";
import { THE_SPEAKER } from "./core/speakers.ts";
import { testPlugin } from "./testing.ts";

// The Pi runtime sends the model a tool described anew before a turn of the same open session.

test("notify described anew before a turn reaches the model in that turn, in the same session", async () => {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-notify-describe-"));
	const seen: TranscriptContext[] = [];
	const core = createFauxCore({ provider: "faux", models: [{ id: "faux-1" }] });
	const look = (context: TranscriptContext) => {
		seen.push(context);
		return fauxAssistantMessage("OK.");
	};
	core.setResponses([look, look]);
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
	let who: OwnerIdentity = addresseeOf({ displayName: "Ann" });
	let built = 0;
	const harness = await testPlugin(
		definePlugin({
			name: "describe",
			providers: {
				runtime: (deps) =>
					new PiAgentRuntime({
						owner: { id: "owner", ...addresseeOf({ displayName: "Riley" }) },
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
				personas: [{ kind: "room", prompt: () => "You keep a room." }],
				toolTiers: { notify: "member" },
				sessionTools: [
					{
						name: "notify-probe",
						phase: "tools",
						snapshot: () => ({
							revision: 0,
							factory: () => (pi) => {
								built += 1;
								pi.registerTool({
									name: "compact_session",
									label: "compact_session",
									description: "Test compactor registration.",
									parameters: Type.Object({}),
									execute: async () => {
										throw new Error("not scripted");
									},
								});
								return notifyExtension(
									{
										notifier: { notify: async () => true },
										recipient: async () => ({ principalId: "ann" }),
										channels: "a direct message on Discord",
									},
									who,
									async () => who,
								)(pi);
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
	const turn = () =>
		runtime.runTurn({
			channel: "fake:room",
			kind: "room",
			text: "Hello.",
			speaker: { id: "ann", name: "Ann", tier: "member", principalId: "ann" },
			selection: { id: "room", tools: ["notify"], groups: [] },
		});
	const description = (context: TranscriptContext | undefined) =>
		JSON.stringify(context?.messages.filter((m) => m.role === "system"));
	try {
		expect((await turn()).ok).toBe(true);
		const builtFirst = built;
		who = THE_SPEAKER;
		expect((await turn()).ok).toBe(true);
		// Same session: nothing was rebuilt.
		expect(built).toBe(builtFirst);
		expect(description(seen[0])).toContain("Send Ann a direct message");
		const [, second] = seen;
		const current = JSON.stringify(
			second?.messages.filter((m) => m.role === "system").at(-1),
		);
		expect(current).toContain("Send the speaker a direct message");
	} finally {
		await harness.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});
