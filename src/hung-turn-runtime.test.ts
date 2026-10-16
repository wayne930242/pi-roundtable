import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { definePlugin } from "./core/define.ts";
import { NO_ATTACHMENTS } from "./core/domain/attachment.ts";
import { PiAgentRuntime } from "./core/runtime/pi-agent-runtime.ts";
import { OWNER_SPEAKER, testPlugin } from "./testing.ts";

/**
 * A real Pi turn on a provider whose first request never answers and ignores the abort, like a
 * model subprocess that does not die; later requests answer.
 */
async function fixture(
	options: {
		stopping?: () => boolean;
		turnTimeoutMs?: number;
		turnMaxMs?: number;
		turnAbortGraceMs?: number;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-hung-"));
	const core = createFauxCore({ provider: "faux", models: [{ id: "faux-1" }] });
	core.setResponses([fauxAssistantMessage([fauxText("back again")])]);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const requests = { count: 0 };
	modelRuntime.registerProvider("faux", {
		api: core.api,
		apiKey: "test",
		baseUrl: "http://faux.invalid",
		streamSimple: (model, context, streamOptions) => {
			requests.count += 1;
			if (requests.count === 1) return createAssistantMessageEventStream();
			return core.streamSimple(model, context, streamOptions);
		},
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
			name: "hung",
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
						turnTimeoutMs: options.turnTimeoutMs ?? 40,
						turnAbortGraceMs: options.turnAbortGraceMs ?? 40,
						...(options.turnMaxMs ? { turnMaxMs: options.turnMaxMs } : {}),
						...(options.stopping ? { stopping: options.stopping } : {}),
					}),
			},
			setup: () => ({
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
	return {
		requests,
		run: () =>
			harness.turns.run({
				channel: "fake:room",
				kind: "owner",
				text: "hello",
				speaker: OWNER_SPEAKER,
				selection: { id: "hung", tools: [], groups: [] },
				steerable: true,
			}),
		steer: (text: string) =>
			harness.runtime?.steer("fake:room", text, NO_ATTACHMENTS),
		close: async () => {
			await harness.stop();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("a turn that outlives its timeout and its abort grace ends as failed, so it cannot hold the queue, and the next turn gets a new session", async () => {
	const f = await fixture();
	try {
		const started = Date.now();
		const first = await f.run();
		expect(first.ok).toBe(false);
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(await f.run()).toMatchObject({ ok: true, text: "back again" });
		expect(f.requests.count).toBe(2);
	} finally {
		await f.close();
	}
});

test("no turn starts once the host is shutting down", async () => {
	const f = await fixture({ stopping: () => true });
	try {
		const result = await f.run();
		expect(result.ok).toBe(false);
		expect(f.requests.count).toBe(0);
	} finally {
		await f.close();
	}
});

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

test("a steered message gives the turn its full budget again from that moment", async () => {
	const f = await fixture({ turnTimeoutMs: 400, turnAbortGraceMs: 40 });
	try {
		const started = Date.now();
		const turn = f.run();
		await sleep(250);
		expect(await f.steer("one more thing")).toBe(true);
		const result = await turn;
		const took = Date.now() - started;
		expect(result.ok).toBe(false);
		// Renewed at 250 ms, so the 400 ms budget ends near 650 ms, not at 400 ms.
		expect(took).toBeGreaterThanOrEqual(600);
		expect(took).toBeLessThan(2_000);
	} finally {
		await f.close();
	}
});

test("steers stop renewing at the cap, the cap aborts the turn, and a steer after it is refused", async () => {
	const f = await fixture({
		turnTimeoutMs: 400,
		turnMaxMs: 700,
		turnAbortGraceMs: 600,
	});
	try {
		const started = Date.now();
		let ended = 0;
		const turn = f.run().then((result) => {
			ended = Date.now() - started;
			return result;
		});
		await sleep(250);
		expect(await f.steer("first")).toBe(true);
		await sleep(250);
		// Renewed to 900 ms, but capped at 700 ms.
		expect(await f.steer("second")).toBe(true);
		await sleep(300);
		// Past the cap and inside the abort grace: the turn runs but takes no more steering.
		expect(ended).toBe(0);
		expect(await f.steer("third")).toBe(false);
		const result = await turn;
		expect(result.ok).toBe(false);
		// The cap fired near 700 ms and the grace of 600 ms followed.
		expect(ended).toBeGreaterThanOrEqual(1_250);
		expect(ended).toBeLessThan(1_700);
	} finally {
		await f.close();
	}
});
