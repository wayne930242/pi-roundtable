import { afterEach, describe, expect, test } from "bun:test";
import { Type } from "typebox";
import { hasWebAccess } from "./core/testing/test-host.ts";
import { DISCORD } from "./discord/index.ts";
import {
	AGENTS,
	type AgentRuntime,
	type AgentServer,
	type AgentTeam,
	BACKGROUND_TURNS,
	type BackgroundTurns,
	type ChannelKey,
	type ChatSurface,
	type ConversationTurns,
	definePlugin,
	defineTool,
	type InboundMessage,
	type Judge,
	NotLinkedError,
	OWNER_TARGET,
	type PendingConfirmation,
	PluginError,
	SCHEDULES,
	type Services,
	serviceKey,
	ToolRefusal,
} from "./index.ts";
import {
	describeDb,
	fakeDiscord,
	partial,
	recordingLogger,
	servicePair,
	type TestHost,
	testHost,
	testPlugin,
} from "./testing.ts";

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
			{ speaker: { id: "1", name: "Alice", tier: "owner" } },
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

const whereAmI = defineTool({
	name: "where_am_i",
	description: "Says the channel and speaker of the turn",
	parameters: Type.Object({}),
	minTier: "member",
	run: (_args, turn) => `${turn.channel} ${turn.speaker?.name ?? "nobody"}`,
});

test("runTool runs in the channel and for the speaker it is given, test:1 by default", async () => {
	const harness = await testPlugin(
		definePlugin({ name: "where", setup: () => ({ tools: [whereAmI] }) }),
	);
	expect(await harness.runTool("where_am_i", {})).toBe("test:1 nobody");
	expect(
		await harness.runTool(
			"where_am_i",
			{},
			{
				channel: "fake:room",
				speaker: { id: "1", name: "Ada", tier: "member" },
			},
		),
	).toBe("fake:room Ada");
	await harness.stop();
});

function probeServices(read: (services: Services) => unknown) {
	return definePlugin({
		name: "probe",
		setup: ({ services }) => {
			read(services);
			return { services: [{ name: "idle" }] };
		},
	});
}

test("services gives the plugin the members the test names, and refuses the others by name", async () => {
	const runtime = { stop: () => false } as unknown as AgentRuntime;
	let read: unknown;
	let refused: unknown;
	await testPlugin(
		probeServices((services) => {
			read = services.get(AGENTS).runtime;
			try {
				services.get(AGENTS).team;
			} catch (error) {
				refused = error;
			}
		}),
		{ services: [servicePair(AGENTS, { runtime })] },
	);
	expect(read).toBe(runtime);
	expect(refused).toBeInstanceOf(PluginError);
	expect(String(refused)).toContain(
		'testPlugin gave service roundtable.agents no "team". Give it in the services option: testPlugin(plugin, { services: [servicePair(KEY, { team: ... })] })',
	);
});

test("a service the test did not give says to pass it, and reads as absent to find", async () => {
	let refused = "";
	let found: unknown = "unset";
	await testPlugin(
		probeServices((services) => {
			found = services.find(SCHEDULES);
			try {
				services.get(SCHEDULES);
			} catch (error) {
				refused = String(error);
			}
		}),
	);
	expect(found).toBeUndefined();
	expect(refused).toContain("service roundtable.schedules is not provided.");
	expect(refused).toContain("give it in the services option");
	expect(refused).not.toContain("Register a plugin");
});

test("a plugin under test that requires a service has it given by the test, and is refused without", async () => {
	const key = serviceKey<{ n: number }>("probe.required");
	let read = 0;
	const plugin = definePlugin({
		name: "needs",
		requires: [key],
		setup: ({ services }) => {
			read = services.get(key).n;
			return { services: [{ name: "needs" }] };
		},
	});
	await testPlugin(plugin, { services: [servicePair(key, { n: 7 })] });
	expect(read).toBe(7);
	await expect(testPlugin(plugin)).rejects.toThrow(
		"plugin needs: requires service probe.required, which no registered plugin provides.",
	);
});

test("a lazy service of a plugin under test answers once setup is over", async () => {
	const key = serviceKey<{ n: number }>("probe.lazy");
	let reader: (() => { n: number }) | undefined;
	await testPlugin(
		probeServices((services) => {
			reader = services.lazy(key);
			expect(() => reader?.()).toThrow(NotLinkedError);
		}),
		{ services: [servicePair(key, { n: 3 })] },
	);
	expect(reader?.().n).toBe(3);
});

test("a plugin under test that declares a service must provide it, and may read its own", async () => {
	const key = serviceKey<{ n: number }>("probe.n");
	const harness = await testPlugin(
		definePlugin({
			name: "provider",
			provides: [key],
			setup: ({ services }) => {
				services.provide(key, { n: 1 });
				return { services: [{ name: "idle" }] };
			},
		}),
	);
	await harness.stop();
	await expect(
		testPlugin(
			definePlugin({
				name: "lazy",
				provides: [key],
				setup: () => ({ services: [{ name: "idle" }] }),
			}),
		),
	).rejects.toThrow(
		"plugin lazy: declares that it provides service probe.n, but setup did not provide it",
	);
});

test("a plugin written for 0.1.0 that reads context.core is refused, naming context.services", async () => {
	await expect(
		testPlugin(
			definePlugin({
				name: "old",
				setup: (context) => {
					// SAFETY: the removed property is read on purpose, to see how it fails.
					(context as unknown as { core: unknown }).core;
					return { services: [{ name: "idle" }] };
				},
			}),
		),
	).rejects.toThrow("plugin old: context.core was removed in 0.2.0");
});

/** A claim that answers every message in `claimed:` channels, and records what it was asked. */
function claiming(log: string[]) {
	return definePlugin({
		name: "claiming",
		setup: () => ({
			channels: [
				{
					name: "claimed",
					priority: 1,
					owns: (channel) => channel.startsWith("claimed:"),
					admit: (message) => ({
						kind: "turn",
						run: async () => void log.push(`turn ${message.text}`),
						failure: "failed",
					}),
					startFresh: async () => "claimed-kind",
					stop: (channel) => {
						log.push(`stop ${channel}`);
						return true;
					},
				},
			],
		}),
	});
}

test("conversations route to the claims of the plugin under test, and a method given replaces the router's", async () => {
	const log: string[] = [];
	const harness = await testPlugin(claiming(log));
	await harness.conversations.handle({
		channel: "claimed:1",
		messageId: "m1",
		authorId: "1",
		authorName: "Ada",
		authorIsBot: false,
		isDirect: true,
		mentionsBot: false,
		repliesToBot: false,
		text: "hello",
		attachments: [],
	});
	expect(log).toEqual(["turn hello"]);
	expect(await harness.conversations.startFresh("claimed:1")).toBe(
		"claimed-kind",
	);
	expect(harness.conversations.stop("claimed:1")).toBe(true);
	const replaced = await testPlugin(claiming([]), {
		conversations: { stop: () => false },
	});
	expect(replaced.conversations.stop("claimed:1")).toBe(false);
});

test("conversations are refused during setup with the host's words", async () => {
	await expect(
		testPlugin(
			definePlugin({
				name: "early",
				setup: (context) => {
					context.conversations.stop("x:1");
					return { events: {} };
				},
			}),
		),
	).rejects.toThrow("conversations are linked once every plugin is set up");
});

test("turns refused during setup reject with NotLinkedError", async () => {
	let early: Promise<unknown> | undefined;
	const harness = await testPlugin(
		definePlugin({
			name: "early-turn",
			setup: ({ turns }) => {
				early = turns
					.run({
						channel: "x:1",
						kind: "k",
						text: "t",
						speaker: { id: "1", name: "A", tier: "owner" },
					})
					.catch((error: unknown) => error);
				return { events: {} };
			},
		}),
	);
	expect(await early).toBeInstanceOf(NotLinkedError);
	await harness.stop();
});

test("injected surfaces are in context.surfaces, start with the plugin, and stop with the harness", async () => {
	const log: string[] = [];
	const surface: ChatSurface = {
		surface: "log",
		start: async () => void log.push("start"),
		stop: async () => void log.push("stop"),
		sendReply: async (channel) => void log.push(`reply ${channel}`),
	};
	const harness = await testPlugin(
		definePlugin({
			name: "quiet",
			setup: () => ({ services: [{ name: "idle" }] }),
		}),
		{ surfaces: [surface] },
	);
	expect(harness.surfaces.of("log:1")).toBe(surface);
	await harness.surfaces.sendReply("log:1", { chunks: ["hi"] });
	await harness.stop();
	expect(log).toEqual(["start", "reply log:1", "stop"]);
});

test("a replaced turns is what the plugin sees, and a plugin that fills the runtime slot gets its runtime built", async () => {
	let seen: ConversationTurns | undefined;
	const turns: ConversationTurns = {
		run: async () => ({ ok: true, text: "replaced" }),
	};
	await testPlugin(
		definePlugin({
			name: "uses-turns",
			setup: (context) => {
				seen = context.turns;
				return { services: [{ name: "idle" }] };
			},
		}),
		{ turns },
	);
	expect(seen).toBe(turns);
	const built: string[] = [];
	const runtime = { stop: () => false } as unknown as AgentRuntime;
	const harness = await testPlugin(
		definePlugin({
			name: "fills-runtime",
			providers: {
				runtime: (deps) => {
					built.push(`${deps.owner.name} ${deps.env.timeZone}`);
					return runtime;
				},
			},
			setup: () => ({}),
		}),
	);
	expect(harness.runtime).toBe(runtime);
	expect(built).toEqual(["Owner UTC"]);
	await harness.stop();
});

test("fakeDiscord stands in for DISCORD: it records the commands a plugin adds, composes them under the root, and refuses what the Discord plugin refuses", async () => {
	const discord = fakeDiscord({ ownerId: "42", rootCommand: "robin" });
	const module = (...names: string[]) => ({
		commands: () =>
			names.map((name) => ({ name, description: name, type: 1 as const })),
		handle: async () => false,
	});
	const adder = definePlugin({
		name: "adder",
		setup: ({ services }) => {
			const { commands, guard } = services.get(DISCORD);
			expect(guard.root).toBe("robin");
			expect(guard.isOwner({ user: { id: "42" } })).toBe(true);
			expect(guard.isOwner({ user: { id: "43" } })).toBe(false);
			commands.add({
				module: module("roll"),
				rootOptions: [{ type: 1, name: "help", description: "help" }],
			});
			return {};
		},
	});
	await (await testPlugin(adder, { services: [discord.service] })).stop();
	expect(discord.added()).toHaveLength(1);
	const { commands } = discord.compose();
	expect(commands.map((command) => command.name)).toEqual(["roll", "robin"]);
	expect(() => discord.commands.add({ module: module() })).toThrow(
		"commands can be added only while plugins set up",
	);
	// A member the fake does not give throws with the option that gives it.
	const greedy = definePlugin({
		name: "greedy",
		setup: ({ services }) => {
			void services.get(DISCORD).threads;
			return {};
		},
	});
	await expect(
		testPlugin(greedy, { services: [fakeDiscord().service] }),
	).rejects.toThrow('gave service roundtable.discord no "threads"');
});

test("holds chains the plugin's hold rules as the host links them", async () => {
	const harness = await testPlugin(
		definePlugin({
			name: "holding",
			setup: () => ({
				holdRules: [
					{
						name: "no-rm",
						describe: (tool, input) =>
							tool === "bash" && String(input.command).startsWith("rm")
								? "Delete files"
								: undefined,
					},
				],
			}),
		}),
	);
	expect(harness.holds("bash", { command: "rm -r x" }, {})).toBe(
		"Delete files",
	);
	expect(harness.holds("bash", { command: "ls" }, {})).toBeUndefined();
});

test("the real background turns reach the plugin's claim for its target", async () => {
	const turns: string[] = [];
	let background: BackgroundTurns | undefined;
	const plugin = definePlugin({
		name: "backgrounded",
		setup: ({ services }) => {
			background = services.get(BACKGROUND_TURNS);
			return {
				backgroundTargets: [OWNER_TARGET],
				channels: [
					{
						name: "claimed",
						priority: 1,
						owns: (channel) => channel.startsWith("claimed:"),
						admit: () => undefined,
						startFresh: async () => "claimed-kind",
						background: async (turn) => {
							turns.push(`${turn.target} ${turn.text}`);
							return { status: "ran" };
						},
					},
				],
			};
		},
	});
	await testPlugin(plugin);
	const outcome = await background?.runErrorReport("claimed:1", "boom");
	expect(outcome).toEqual({ status: "ran" });
	expect(turns).toEqual(["owner boom"]);
});

const judging = (choice: string): Judge => ({
	askYesNo: async () => ({}),
	askChoice: async () => ({ choice, confidence: 0.9 }),
	askScore: async () => [],
});

test("approvals are the real confirmation judge over the judge provider once AGENTS is given", async () => {
	const held: PendingConfirmation = {
		selectionId: "s",
		heldAt: new Date(0),
		calls: [{ tool: "bash", action: "Delete files", input: {} }],
	} as PendingConfirmation;
	const asked = async (choice: string) => {
		let approvals: AgentServer["approvals"] | undefined;
		const plugin = definePlugin({
			name: "approving",
			setup: ({ services }) => {
				approvals = services.get(AGENTS).approvals;
				return {};
			},
		});
		await testPlugin(plugin, {
			providers: { judge: judging(choice) },
			services: [servicePair(AGENTS, {})],
		});
		if (!approvals) throw new Error("the plugin was not set up");
		return approvals.approves(held, "go ahead");
	};
	expect(await asked("approve")).toBe(true);
	expect(await asked("decline")).toBe(false);
});

test("a team given to AGENTS brings the agent server's claim, which outranks the plugin's for an agent's channel", async () => {
	const log: string[] = [];
	const team = {
		guildId: "g",
		owns: (channel: string) =>
			channel === "discord:agent" ? "agent" : undefined,
		answerOwner: async (_c: string, _s: unknown, text: string) => {
			log.push(`agent ${text}`);
			return { ok: true, text: "" };
		},
		answerGroup: async () => undefined,
		answerBackground: async () => ({ ok: true, text: "" }),
		startFresh: async () => undefined,
	};
	const harness = await testPlugin(
		definePlugin({
			name: "greedy",
			setup: () => ({
				channels: [
					{
						name: "greedy",
						priority: 1,
						owns: () => true,
						admit: (message) => ({
							kind: "turn",
							run: async () => void log.push(`plugin ${message.text}`),
							failure: "failed",
						}),
						startFresh: async () => "greedy",
					},
				],
			}),
		}),
		{
			owner: { id: "42", name: "Ada" },
			// SAFETY: the team stands in for the concrete members the agent server's claim reads.
			services: [servicePair(AGENTS, { team: team as never })],
		},
	);
	const message = (channel: ChannelKey, text: string): InboundMessage => ({
		channel,
		messageId: "m",
		authorId: "42",
		authorName: "Ada",
		authorIsBot: false,
		isDirect: false,
		mentionsBot: false,
		repliesToBot: false,
		text,
		space: "g",
		attachments: [],
	});
	await harness.conversations.handle(message("discord:agent", "to the agent"));
	await harness.conversations.handle(message("other:1", "to the plugin"));
	expect(log).toEqual(["agent to the agent", "plugin to the plugin"]);
});

let host: TestHost | undefined;
afterEach(async () => {
	await host?.stop();
	host = undefined;
});

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set and the delegation worker can load.
(hasWebAccess() ? describeDb : describe.skip)("testHost", () => {
	test("boots the built-in plugins and yours, records the commands they add, and lists a session's tools", async () => {
		const module = {
			commands: () => [{ name: "roll", description: "roll", type: 1 as const }],
			handle: async () => false,
		};
		host = await testHost({
			plugins: [
				definePlugin({
					name: "roller",
					setup: ({ services }) => {
						services.get(DISCORD).commands.add({ module });
						return {};
					},
				}),
			],
		});
		expect(host.commands.added.some((each) => each.module === module)).toBe(
			true,
		);
		expect(host.commands.composed().commands.map((c) => c.name)).toContain(
			"roll",
		);
		const owner = await host.sessionTools();
		expect(owner.flatMap((each) => each.tools)).toContain("memory_add");
		expect(host.sessionContext().kind).toBe("owner");
		const scout = {
			name: "scout",
			session: "discord:s",
			home: "discord:s",
		} as const;
		expect(host.sessionContext(scout).agent).toEqual(scout);
		expect(host.context.services.find(AGENTS)).toBeDefined();
	});

	test("apiKey reads as no credential unless the test gives one", async () => {
		host = await testHost();
		expect(await host.context.apiKey("openai-codex")).toBeUndefined();
		await host.stop();
		host = await testHost({ apiKeys: { "openai-codex": "key-1" } });
		expect(await host.context.apiKey("openai-codex")).toBe("key-1");
		expect(await host.context.apiKey("other")).toBeUndefined();
	});
});

test("partial is a typed stand-in with the members the test gives, and names any other it is asked for", async () => {
	const team = partial<AgentTeam>({
		announce: async () => undefined,
		guildId: "g",
	});
	expect(team.guildId).toBe("g");
	await expect(team.announce("hi")).resolves.toBeUndefined();
	expect(() => team.status).toThrow(
		'partial() was given no "status". Give it where the stand-in is made: partial({ status: ... }).',
	);
	// A promise check and a JSON dump do not trip it.
	expect((team as unknown as { then?: unknown }).then).toBeUndefined();
	expect(JSON.stringify(partial<{ a: number }>({ a: 1 }))).toBe('{"a":1}');
});

test("recordingLogger keeps each line with its level, the fields of its children, and its message", () => {
	const { logger, lines } = recordingLogger();
	logger.info("plain");
	const child = logger.child({ plugin: "p" });
	child.warn({ id: 3 }, "with fields");
	child.child({ job: "j" }).error({ err: "x" }, "nested");
	expect(lines).toEqual([
		{ level: "info", fields: {}, message: "plain" },
		{ level: "warn", fields: { plugin: "p", id: 3 }, message: "with fields" },
		{
			level: "error",
			fields: { plugin: "p", job: "j", err: "x" },
			message: "nested",
		},
	]);
});
