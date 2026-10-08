import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxCore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { coding } from "../packages/coding/src/coding-plugin.ts";
import { ConfigError } from "./core/domain/errors.ts";
import type { LinkedSessions } from "./core/plugin.ts";
import { PiAgentRuntime } from "./core/runtime/pi-agent-runtime.ts";
import { IDENTITY, SKILLS } from "./core/services.ts";
import type { SessionConversation } from "./core/sessions.ts";
import { servicePair, silentLogger, testPlugin } from "./testing.ts";

/** Real coding contribution and Pi session loading, without a model request or a database. */
async function fixture(requiredTools: readonly string[]) {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-preflight-"));
	const scopes: SessionConversation[] = [];
	const principals: string[] = [];
	const harness = await testPlugin(
		coding({ shelfDir: join(dir, "shelf"), model: "faux/faux-1" }),
		{
			services: [
				servicePair(SKILLS, { list: () => "Private skills" }),
				servicePair(IDENTITY, {
					tierOf: async (id) => {
						principals.push(id);
						return id === "primary-principal" ? "owner" : undefined;
					},
				}),
			],
		},
	);
	try {
		const core = createFauxCore({
			provider: "faux",
			models: [{ id: "faux-1" }],
		});
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
		const linked: LinkedSessions = {
			holds: harness.holds,
			piPackages: [],
			seeds: [],
			prompt: [],
			persona: () => undefined,
			requiredTools,
			agentTools: [],
			agentSelection: () => ({ id: "test", tools: [], groups: [] }),
			plan: {
				mcp: [],
				tools: [
					...(harness.contribution.sessionTools ?? []),
					{
						name: "probe-scope",
						phase: "tools",
						snapshot: () => ({
							revision: 0,
							factory: (session) => {
								scopes.push(session.conversation);
								return (pi) => {
									// Stand-in for the host compactor, required by every preflight.
									for (const name of [
										"compact_session",
										...(session.conversation.visibility === "shared"
											? ["shared_probe_tool"]
											: []),
									])
										pi.registerTool({
											name,
											label: name,
											description: "Test probe tool.",
											parameters: Type.Object({}),
											execute: async () => {
												throw new Error("preflight must not execute tools");
											},
										});
								};
							},
						}),
					},
				],
			},
		};
		const runtime = new PiAgentRuntime({
			owner: {
				id: "primary-principal",
				name: "Riley",
				pronouns: { subject: "they", object: "them", possessive: "their" },
			},
			agentDir: dir,
			dataDir: dir,
			modelRuntime,
			model: { provider: "faux", id: "faux-1" },
			thinking: "off",
			effort: { judge: async () => "off" },
			logger: silentLogger(),
			confirmations: { load: async () => undefined, save: async () => {} },
			sessions: () => linked,
		});
		return {
			runtime,
			scopes,
			principals,
			close: async () => {
				await harness.stop();
				rmSync(dir, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await harness.stop();
		rmSync(dir, { recursive: true, force: true });
		throw error;
	}
}

test("preflight boots with coding and requiredTools containing only skill_list", async () => {
	const f = await fixture(["skill_list"]);
	try {
		await f.runtime.preflight();
		expect(f.scopes).toEqual([
			{ visibility: "shared" },
			{ visibility: "private", principalId: "primary-principal" },
		]);
		expect(f.principals).toEqual(["primary-principal"]);
	} finally {
		await f.close();
	}
});

test("preflight builds no private probe when the shared one has every required tool", async () => {
	const f = await fixture(["shared_probe_tool"]);
	try {
		await f.runtime.preflight();
		expect(f.scopes).toEqual([{ visibility: "shared" }]);
		expect(f.principals).toEqual([]);
	} finally {
		await f.close();
	}
});

test("preflight checks the union of owner-private and shared-only tools", async () => {
	const f = await fixture(["skill_list", "shared_probe_tool"]);
	try {
		await expect(f.runtime.preflight()).resolves.toBeUndefined();
	} finally {
		await f.close();
	}
});

test("preflight still raises ConfigError for tools registered in neither scope", async () => {
	const f = await fixture(["skill_list", "unregistered_tool"]);
	try {
		await expect(f.runtime.preflight()).rejects.toBeInstanceOf(ConfigError);
		await expect(f.runtime.preflight()).rejects.toThrow(
			"required tools are not registered: unregistered_tool.",
		);
	} finally {
		await f.close();
	}
});
