import { expect, test } from "bun:test";
import { Type } from "typebox";
import {
	type AgentRuntime,
	definePlugin,
	defineTool,
	SCHEDULES,
	ToolRefusal,
} from "./index.ts";
import { testPlugin } from "./testing.ts";

test("the testing entry imports in CI without a database URL", () => {
	const env: Record<string, string | undefined> = {
		...process.env,
		CI: "true",
	};
	delete env.ROUNDTABLE_TEST_DATABASE_URL;
	const run = Bun.spawnSync(
		[
			process.execPath,
			"-e",
			'const { testPlugin } = await import("pi-roundtable/testing"); if (typeof testPlugin !== "function") throw new Error("missing harness");',
		],
		{ cwd: import.meta.dir, env, stdout: "pipe", stderr: "pipe" },
	);
	expect(run.stderr.toString()).toBe("");
	expect(run.exitCode).toBe(0);
});

const note = defineTool({
	name: "note_add",
	description: "Write a note",
	parameters: Type.Object({ text: Type.String() }),
	minTier: "member",
	hold: (args) => (args.text === "danger" ? "Confirm note" : undefined),
	run: (args, turn) => {
		if (!args.text) throw new ToolRefusal("empty note");
		return `${turn.speaker?.name ?? "anonymous"}: ${args.text}`;
	},
});

test("the harness records the tiers a plugin names for its raw session tools", async () => {
	const harness = await testPlugin(
		definePlugin({
			name: "raw",
			setup: () => ({ toolTiers: { raw_look: "member", raw_change: "admin" } }),
		}),
	);
	expect(harness.tiers.minTier("raw_look")).toBe("member");
	expect(harness.tiers.minTier("raw_change")).toBe("admin");
	expect(harness.tiers.minTier("raw_other")).toBe("owner");
});

test("the harness registers tools through their session factories and records tiers and holds", async () => {
	const harness = await testPlugin(
		definePlugin({ name: "notes", setup: () => ({ tools: [note] }) }),
	);
	expect(harness.tools).toEqual(["note_add"]);
	expect(harness.tiers.minTier("note_add")).toBe("member");
	expect(
		harness.contribution.holdRules?.[0]?.describe(
			"note_add",
			{ text: "danger" },
			{},
		),
	).toBe("Confirm note");
	expect(
		await harness.runTool(
			"note_add",
			{ text: "hello" },
			{ speaker: { id: "1", name: "Alice", tier: "owner", principalId: "1" } },
		),
	).toBe("Alice: hello");
	expect(await harness.runTool("note_add", { text: "" })).toBe("empty note");
	await harness.stop();
});

test("ordinary tool errors reject the call rather than becoming model-visible refusals", async () => {
	const broken = defineTool({
		name: "broken_tool",
		description: "Fail",
		parameters: Type.Object({}),
		minTier: "owner",
		run: () => {
			throw new Error("disk unavailable");
		},
	});
	const harness = await testPlugin(
		definePlugin({ name: "broken", setup: () => ({ tools: [broken] }) }),
	);
	await expect(harness.runTool("broken_tool", {})).rejects.toThrow(
		"disk unavailable",
	);
	await harness.stop();
});

test("database and built-in services fail with the host's errors until provided", async () => {
	let databaseError = "";
	let coreError = "";
	const harness = await testPlugin(
		definePlugin({
			name: "ports",
			setup: (context) => {
				try {
					context.database();
				} catch (error) {
					databaseError = String(error);
				}
				try {
					context.services.get(SCHEDULES);
				} catch (error) {
					coreError = String(error);
				}
				return { events: {} };
			},
		}),
	);
	expect(databaseError).toBe("PluginError: no database is configured");
	expect(coreError).toContain(
		"service roundtable.schedules is not provided. testPlugin has no built-in plugins",
	);
	await harness.stop();
});

test("the plugin's preflight runs after setup and before its services start", async () => {
	const order: string[] = [];
	const harness = await testPlugin({
		name: "ordered",
		preflight: () => {
			order.push("preflight");
		},
		setup: () => {
			order.push("setup");
			return {
				services: [
					{
						name: "ordered",
						start: () => {
							order.push("start");
						},
					},
				],
			};
		},
	});
	expect(order).toEqual(["setup", "preflight", "start"]);
	await harness.stop();
});

/** A runtime that does nothing, with what a test lets it do in place of that. */
const idleRuntime = (own: Partial<AgentRuntime> = {}): AgentRuntime => ({
	runTurn: async () => ({ ok: true, text: "" }),
	steer: async () => false,
	stop: () => false,
	startFresh: async () => undefined,
	deleteConversation: async () => undefined,
	pendingConfirmation: () => undefined,
	heldActions: async () => undefined,
	recentTranscript: async () => [],
	...own,
});

test("a plugin whose preflight throws fails testPlugin with that error before any service starts, and disposes the runtime it built", async () => {
	const started: string[] = [];
	const disposed: string[] = [];
	await expect(
		testPlugin({
			name: "refusing",
			providers: {
				runtime: () =>
					idleRuntime({ dispose: async () => void disposed.push("runtime") }),
			},
			preflight: () => {
				throw new Error("not ready");
			},
			setup: () => ({
				services: [
					{ name: "refusing", start: () => void started.push("start") },
				],
			}),
		}),
	).rejects.toThrow("not ready");
	expect(started).toEqual([]);
	expect(disposed).toEqual(["runtime"]);
});

test("the runtime's own preflight runs after the plugin's and before its services start", async () => {
	const order: string[] = [];
	const harness = await testPlugin({
		name: "probed",
		providers: {
			runtime: () =>
				idleRuntime({
					preflight: async () => void order.push("runtime preflight"),
				}),
		},
		preflight: () => void order.push("preflight"),
		setup: () => {
			order.push("setup");
			return {
				services: [{ name: "probed", start: () => void order.push("start") }],
			};
		},
	});
	expect(order).toEqual(["setup", "preflight", "runtime preflight", "start"]);
	await harness.stop();
});

test("a runtime whose preflight throws fails testPlugin with that error before any service starts, and is disposed", async () => {
	const started: string[] = [];
	const disposed: string[] = [];
	await expect(
		testPlugin({
			name: "unready",
			providers: {
				runtime: () =>
					idleRuntime({
						preflight: async () => {
							throw new Error("model not reachable");
						},
						dispose: async () => void disposed.push("runtime"),
					}),
			},
			setup: () => ({
				services: [
					{ name: "unready", start: () => void started.push("start") },
				],
			}),
		}),
	).rejects.toThrow("model not reachable");
	expect(started).toEqual([]);
	expect(disposed).toEqual(["runtime"]);
});

test("events reach the plugin and are recorded", async () => {
	const received: string[] = [];
	const harness = await testPlugin(
		definePlugin({
			name: "listener",
			setup: (context) => {
				context.events.turnStarted({
					agent: "helper",
					kind: "agent",
					channel: "test:1",
					speaker: undefined,
				});
				return {
					events: {
						shutdown: () => {
							received.push("shutdown");
						},
					},
				};
			},
		}),
	);
	expect(harness.events).toEqual([
		{
			name: "turnStarted",
			turn: {
				agent: "helper",
				kind: "agent",
				channel: "test:1",
				speaker: undefined,
			},
		},
	]);
	await harness.stop();
	expect(received).toEqual(["shutdown"]);
});

test("a plugin that adds nothing gets the host's exact refusal", async () => {
	await expect(
		testPlugin(definePlugin({ name: "empty", setup: () => ({}) })),
	).rejects.toThrow(
		"plugin empty adds nothing. Give it a part (tools, services, channels, and so on), a migration, or a provider, or remove it.",
	);
});

test("sessions read during setup carry the host's NotLinkedError text", async () => {
	await expect(
		testPlugin(
			definePlugin({
				name: "early",
				setup: (context) => {
					context.sessions();
					return { events: {} };
				},
			}),
		),
	).rejects.toThrow(
		"session parts are linked once every plugin is set up. Call sessions() from a service's start or from a handler, not during setup.",
	);
});

test("the harness returns the agent selection a plugin contributes", async () => {
	const harness = await testPlugin(
		definePlugin({
			name: "selecting",
			setup: () => ({
				agentSelection: () => ({ tools: ["note_add"], groups: [] }),
			}),
		}),
	);
	expect(harness.contribution.agentSelection?.()).toEqual({
		tools: ["note_add"],
		groups: [],
	});
	await harness.stop();
});

test("the harness says which provider slots are filled, by the plugin or by the options", async () => {
	const seen: string[][] = [];
	const reader = definePlugin({
		name: "reader",
		setup: ({ providers }) => {
			seen.push([...providers.filled]);
			return { events: {} };
		},
	});
	await (await testPlugin(reader)).stop();
	await (
		await testPlugin(reader, {
			providers: { images: async () => new Uint8Array() },
		})
	).stop();
	await (
		await testPlugin(
			definePlugin({
				name: "drawer",
				providers: { images: async () => new Uint8Array() },
				setup: ({ providers }) => {
					seen.push([...providers.filled]);
					return {};
				},
			}),
		)
	).stop();
	expect(seen).toEqual([[], ["images"], ["images"]]);
});

test("listener reads the addresses the test gives, by id", async () => {
	const seen: unknown[] = [];
	const reader = definePlugin({
		name: "where",
		setup: ({ listener }) => {
			seen.push(listener("web"), listener("other"));
			return { events: {} };
		},
	});
	await (
		await testPlugin(reader, {
			listeners: [{ id: "web", port: 8080, hostname: "localhost" }],
		})
	).stop();
	expect(seen).toEqual([{ port: 8080, hostname: "localhost" }, undefined]);
});

test("apiKey reads as no credential by default, and returns the keys the test gives, by provider", async () => {
	const seen: Record<string, string | undefined> = {};
	const reader = definePlugin({
		name: "keys",
		setup: async ({ apiKey }) => {
			for (const provider of ["openai-codex", "other", "toString"])
				seen[provider] = await apiKey(provider);
			return { events: {} };
		},
	});
	await (await testPlugin(reader)).stop();
	expect(seen).toEqual({
		"openai-codex": undefined,
		other: undefined,
		toString: undefined,
	});
	await (
		await testPlugin(reader, { apiKeys: { "openai-codex": "key-1" } })
	).stop();
	expect(seen).toEqual({
		"openai-codex": "key-1",
		other: undefined,
		toString: undefined,
	});
});
