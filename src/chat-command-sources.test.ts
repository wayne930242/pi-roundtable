import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { definePlugin } from "./core/define.ts";
import { ChatCommandSources } from "./core/registry/chat-commands.ts";
import { PiAgentRuntime } from "./core/runtime/pi-agent-runtime.ts";
import { packageDir } from "./core/shared/package-dir.ts";
import type { ChatCommand } from "./index.ts";
import { OWNER_SPEAKER, testPlugin } from "./testing.ts";

const names = (commands: readonly ChatCommand[]) =>
	commands.map((one) => one.name);

describe("which declared chat commands are listed", () => {
	const declare = (sources: ChatCommandSources, name: string) =>
		sources.declare(
			{ name, description: `Run ${name}` },
			{
				packages: ["pi-jev-compaction"],
				sessionTools: ["owned-tool"],
			},
		);

	test("a declaration nothing registered is not listed", () => {
		const sources = new ChatCommandSources();
		declare(sources, "csrc-unregistered");
		sources.loaded([
			{
				invocationName: "csrc-other",
				sourceInfo: { path: "<inline:owned-tool>" },
			},
		]);
		expect(names(sources.listed())).toEqual([]);
	});

	test("a command registered by the declaring plugin's session tool or package is listed", () => {
		const sources = new ChatCommandSources();
		declare(sources, "csrc-from-tool");
		declare(sources, "csrc-from-package");
		sources.loaded([
			{
				invocationName: "csrc-from-tool",
				sourceInfo: { path: "<inline:owned-tool>" },
			},
			{
				invocationName: "csrc-from-package",
				sourceInfo: {
					path: join(packageDir("pi-jev-compaction"), "index.ts"),
				},
			},
		]);
		expect(names(sources.listed())).toEqual([
			"csrc-from-tool",
			"csrc-from-package",
		]);
	});

	test("a command another plugin's extension registers is not listed", () => {
		const sources = new ChatCommandSources();
		declare(sources, "csrc-stolen");
		declare(sources, "csrc-lookalike");
		sources.loaded([
			{
				invocationName: "csrc-stolen",
				sourceInfo: { path: "<inline:someone-elses-tool>" },
			},
			{
				// A folder whose name only starts like the package's is not inside it.
				invocationName: "csrc-lookalike",
				sourceInfo: { path: `${packageDir("pi-jev-compaction")}-x/index.ts` },
			},
		]);
		expect(names(sources.listed())).toEqual([]);
	});
});

test("a session lists a declared command only when the declaring plugin's own extension registered it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-csrc-"));
	const core = createFauxCore({ provider: "faux", models: [{ id: "faux-1" }] });
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
	let listed: (() => readonly ChatCommand[]) | undefined;
	const harness = await testPlugin(
		definePlugin({
			name: "csrc-plugin",
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
			setup: ({ chatCommands }) => {
				listed = chatCommands;
				return {
					personas: [{ kind: "owner", prompt: () => "You are the persona." }],
					chatCommands: [
						{ name: "csrc-real", description: "Registered by this plugin" },
						{ name: "csrc-ghost", description: "Registered by nobody" },
					],
					sessionTools: [
						{
							name: "csrc-tool",
							phase: "tools",
							snapshot: () => ({
								revision: 0,
								factory: () => (pi) => {
									pi.registerCommand("csrc-real", {
										description: "A real command",
										handler: async () => {},
									});
								},
							}),
						},
						{
							name: "csrc-compactor",
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
				};
			},
		}),
	);
	try {
		core.appendResponses([fauxAssistantMessage([fauxText("Hello.")])]);
		const result = await harness.turns.run({
			channel: "csrc-plugin:room",
			kind: "owner",
			text: "hello",
			speaker: OWNER_SPEAKER,
			selection: { id: "csrc-plugin", tools: [], groups: [] },
		});
		expect(result.ok).toBe(true);
		expect(names(listed?.() ?? [])).toEqual(["csrc-real"]);
	} finally {
		await harness.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});
