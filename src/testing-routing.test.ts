import { expect, test } from "bun:test";
import { DISCORD } from "./discord/index.ts";
import {
	type AgentRuntime,
	BACKGROUND_TURNS,
	type BackgroundTurns,
	type ChatSurface,
	type ConversationTurns,
	definePlugin,
	NotLinkedError,
	OWNER_TARGET,
} from "./index.ts";
import { fakeDiscord, testPlugin } from "./testing.ts";

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
						speaker: { id: "1", name: "A", tier: "owner", principalId: "1" },
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
