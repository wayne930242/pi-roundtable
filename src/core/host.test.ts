import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InteractionContextType } from "discord.js";
import type { ChannelClaim, ConversationPort } from "./contract/channels.ts";
import { NotLinkedError, PluginError } from "./errors.ts";
import type { HoldRule } from "./holds.ts";
import { Roundtable, type RoundtableOptions } from "./host.ts";
import { silentLogger } from "./log.ts";
import type { LinkedSessions, RoundtablePlugin, Service } from "./plugin.ts";
import type { SessionTool } from "./sessions.ts";

/** A service that records its start and stop in `log`. */
function recorded(
	name: string,
	log: string[],
	extra: Partial<Service> = {},
): Service {
	return {
		name,
		start: () => {
			log.push(`start ${name}`);
		},
		stop: () => {
			log.push(`stop ${name}`);
		},
		...extra,
	};
}

function plugin(name: string, services: Service[]): RoundtablePlugin {
	return { name, setup: () => ({ services }) };
}

function host(
	plugins: RoundtablePlugin[],
	options: Partial<RoundtableOptions> = {},
): { roundtable: Roundtable; exits: number[] } {
	const exits: number[] = [];
	const roundtable = new Roundtable(
		{
			logger: silentLogger(),
			drain: { intervalMs: 1, limitMs: 50 },
			exit: (code) => exits.push(code),
			...options,
		},
		plugins,
	);
	return { roundtable, exits };
}

describe("Roundtable", () => {
	test("starts services in registration order and stops them in reverse", async () => {
		const log: string[] = [];
		const { roundtable, exits } = host([
			plugin("a", [recorded("a1", log), recorded("a2", log)]),
			plugin("b", [recorded("b1", log)]),
		]);
		await roundtable.run();
		await roundtable.shutdown("SIGTERM");
		expect(log).toEqual([
			"start a1",
			"start a2",
			"start b1",
			"stop b1",
			"stop a2",
			"stop a1",
		]);
		expect(exits).toEqual([0]);
	});

	test("waits for busy work before stopping anything", async () => {
		const log: string[] = [];
		let busy = ["discord:1"];
		const { roundtable } = host([
			plugin("a", [recorded("a1", log, { busy: () => busy })]),
		]);
		await roundtable.run();
		const done = roundtable.shutdown("SIGTERM");
		await Bun.sleep(10);
		expect(log).toEqual(["start a1"]);
		busy = [];
		await done;
		expect(log).toEqual(["start a1", "stop a1"]);
	});

	test("hands aborted work over once the drain limit runs out", async () => {
		const aborted: string[][] = [];
		const { roundtable, exits } = host(
			[plugin("a", [{ name: "a1", busy: () => ["discord:1", "discord:2"] }])],
			{
				aborted: async (left) => {
					aborted.push(left);
				},
			},
		);
		await roundtable.run();
		await roundtable.shutdown("SIGTERM");
		expect(aborted).toEqual([["discord:1", "discord:2"]]);
		expect(exits).toEqual([0]);
	});

	test("keeps stopping the rest when one service fails to stop", async () => {
		const log: string[] = [];
		const { roundtable } = host([
			plugin("a", [
				recorded("a1", log),
				{
					name: "broken",
					stop: () => {
						throw new Error("socket already closed");
					},
				},
			]),
		]);
		await roundtable.run();
		await roundtable.shutdown("SIGTERM");
		expect(log).toEqual(["start a1", "stop a1"]);
	});

	test("tells every plugin how the agent server started, even after a handler fails", async () => {
		const outcomes: string[] = [];
		const run = async (agentServer: () => Promise<void>) => {
			const { roundtable } = host([
				{ name: "server", agentServer, setup: () => ({}) },
				{
					name: "broken",
					setup: () => ({
						events: {
							agentServer: () => {
								throw new Error("channel missing");
							},
						},
					}),
				},
				{
					name: "listener",
					setup: () => ({
						events: {
							agentServer: (outcome) => {
								outcomes.push(outcome);
							},
						},
					}),
				},
			]);
			await roundtable.run();
			await Bun.sleep(5);
		};
		await run(async () => {});
		await run(async () => {
			throw new Error("Missing Access");
		});
		expect(outcomes).toEqual(["ready", "failed"]);
	});

	test("tells the plugins what the drain gave up on before any service stops", async () => {
		const log: string[] = [];
		const { roundtable } = host(
			[
				plugin("a", [recorded("a1", log, { busy: () => ["discord:1"] })]),
				{
					name: "watcher",
					setup: () => ({
						events: {
							shutdown: (left) => {
								log.push(`drained ${left.join(",")}`);
							},
						},
					}),
				},
			],
			{ aborted: async () => {} },
		);
		await roundtable.run();
		await roundtable.shutdown("SIGTERM");
		expect(log).toEqual(["start a1", "drained discord:1", "stop a1"]);
	});

	test("refuses two plugins that both start the agent server", async () => {
		const { roundtable } = host([
			{ name: "a", agentServer: async () => {}, setup: () => ({}) },
			{ name: "b", agentServer: async () => {}, setup: () => ({}) },
		]);
		await expect(roundtable.run()).rejects.toThrow(
			"plugins a and b both start the agent server. Keep one.",
		);
	});

	test("a plugin that only hooks the lifecycle adds something; one with no hook and no part adds nothing", async () => {
		const { roundtable } = host([
			{ name: "hook", preflight: async () => {}, setup: () => ({}) },
		]);
		await roundtable.run();
		await roundtable.shutdown("SIGTERM");
	});

	test("refuses a plugin that adds nothing", async () => {
		const { roundtable } = host([plugin("empty", [])]);
		const error = await roundtable.run().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(PluginError);
	});

	test("refuses two services with one name", async () => {
		const log: string[] = [];
		const { roundtable } = host([
			plugin("a", [recorded("dashboard", log)]),
			plugin("b", [recorded("dashboard", log)]),
		]);
		const error = await roundtable.run().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(PluginError);
		expect(log).toEqual([]);
	});

	test("composes commands before any service starts, and serves HTTP only while every service runs", async () => {
		const log: string[] = [];
		const socketPath = join(mkdtempSync(join(tmpdir(), "host-")), "web.sock");
		const get = async () => {
			try {
				const response = await fetch("http://localhost/ping", {
					unix: socketPath,
				});
				return await response.text();
			} catch {
				return "closed";
			}
		};
		const { roundtable } = host(
			[
				{
					name: "a",
					useCommands: (composed) =>
						log.push(`commands ${composed.commands.map((c) => c.name)}`),
					setup: () => ({
						services: [
							{
								name: "a1",
								start: async () => {
									log.push(`start a1: ${await get()}`);
								},
								stop: async () => {
									log.push(`stop a1: ${await get()}`);
								},
							},
						],
						interactions: [
							{
								module: { commands: () => [], handle: async () => false },
								rootOptions: [{ type: 1, name: "help", description: "help" }],
							},
						],
						http: [
							{
								name: "ping",
								listener: "web",
								path: { exact: "/ping" },
								handle: () => new Response("pong"),
							},
						],
					}),
				},
			],
			{
				commands: {
					root: {
						name: "roundtable",
						description: "control",
						contexts: [InteractionContextType.Guild],
					},
				},
				listeners: [{ id: "web", socketPath }],
			},
		);
		await roundtable.run();
		log.push(`running: ${await get()}`);
		await roundtable.shutdown("SIGTERM");
		expect(log).toEqual([
			"commands roundtable",
			"start a1: closed",
			"running: pong",
			"stop a1: closed",
		]);
	});

	test("links every plugin's hold rules, packages, and session tools once all are set up", async () => {
		const hold = (name: string, tool: string): HoldRule => ({
			name,
			describe: (called) => (called === tool ? name : undefined),
		});
		const tool = (name: string, phase: SessionTool["phase"]): SessionTool => ({
			name,
			phase,
			...(phase === "compaction" ? { engine: name } : {}),
			snapshot: () => ({ revision: 1, factory: () => null }),
		});
		const seen: string[] = [];
		let sessions: (() => LinkedSessions) | undefined;
		const { roundtable } = host([
			{
				name: "a",
				preflight: async () => void seen.push("preflight"),
				setup: (context) => {
					sessions = context.sessions;
					try {
						context.sessions();
					} catch (error) {
						if (error instanceof NotLinkedError) seen.push("not linked");
					}
					return {
						holdRules: [hold("discord", "x"), hold("shell", "y")],
						piPackages: ["pi-web-access", "pi-self-compact"],
						sessionTools: [tool("mcp", "mcp"), tool("memory", "tools")],
					};
				},
			},
			{
				name: "b",
				setup: () => ({
					holdRules: [hold("google", "x")],
					piPackages: ["pi-self-compact", "pi-otel-tracing"],
					sessionTools: [tool("summarizer", "compaction")],
				}),
			},
		]);
		await roundtable.run();
		const linked = sessions?.();
		expect(seen).toEqual(["not linked", "preflight"]);
		// The first rule to describe a call holds it.
		expect(linked?.holds("x", {}, {})).toBe("discord");
		expect(linked?.holds("y", {}, {})).toBe("shell");
		expect(linked?.holds("z", {}, {})).toBeUndefined();
		expect(linked?.piPackages).toEqual([
			"pi-web-access",
			"pi-self-compact",
			"pi-otel-tracing",
		]);
		expect(linked?.plan.tools.map((t) => t.name)).toEqual(["memory"]);
		expect(linked?.plan.compaction?.name).toBe("summarizer");
		expect(linked?.plan.mcp.map((t) => t.name)).toEqual(["mcp"]);
	});

	test("routes conversations to contributed claims once linked, not during setup", async () => {
		const log: string[] = [];
		const claim = (name: string, priority: number): ChannelClaim => ({
			name,
			priority,
			owns: () => true,
			admit: (m) => ({
				kind: "turn",
				run: async () => void log.push(`${name} ${m.text}`),
				failure: "failed",
			}),
			startFresh: async () => name,
		});
		let conversations: ConversationPort | undefined;
		const { roundtable } = host([
			{
				name: "owner",
				stopTurn: (channel) => channel === "discord:1",
				setup: (context) => {
					conversations = context.conversations;
					expect(() => context.conversations.stop("discord:1")).toThrow(
						NotLinkedError,
					);
					return { channels: [claim("owner", 0)] };
				},
			},
			{ name: "party", setup: () => ({ channels: [claim("party", 20)] }) },
		]);
		await roundtable.run();
		await conversations?.handle({
			channel: "discord:1",
			messageId: "m1",
			authorId: "owner",
			authorName: "Riley",
			authorIsBot: false,
			isDirect: true,
			mentionsBot: false,
			repliesToBot: false,
			text: "hi",
			attachments: [],
		});
		expect(log).toEqual(["party hi"]);
		expect(conversations?.stop("discord:1")).toBe(true);
	});

	test("gives the dashboard every plugin's lines in order, once linked", async () => {
		let read: (() => readonly string[]) | undefined;
		let early: unknown;
		const { roundtable } = host([
			{
				name: "web",
				setup: ({ dashboard }) => {
					try {
						dashboard();
					} catch (error) {
						early = error;
					}
					read = dashboard;
					return { dashboard: ["web link"] };
				},
			},
			{ name: "metrics", setup: () => ({ dashboard: ["metrics link"] }) },
		]);
		await roundtable.run();
		expect(early).toBeInstanceOf(NotLinkedError);
		expect(read?.()).toEqual(["web link", "metrics link"]);
	});

	test("refuses clashing session parts before any service starts", async () => {
		const log: string[] = [];
		const rule: HoldRule = { name: "shell", describe: () => undefined };
		const { roundtable } = host([
			{
				name: "a",
				setup: () => ({ services: [recorded("a1", log)], holdRules: [rule] }),
			},
			{ name: "b", setup: () => ({ holdRules: [rule] }) },
		]);
		const error = await roundtable.run().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(PluginError);
		expect(log).toEqual([]);
	});

	describe("a failed startup reaches neither Discord nor a listener", () => {
		/** A host whose one service stands for Discord, with a real web listener. */
		const failing = (
			fail: Pick<RoundtablePlugin, "setup"> | undefined,
			preflight?: () => Promise<void>,
		) => {
			const log: string[] = [];
			const socketPath = join(mkdtempSync(join(tmpdir(), "host-")), "web.sock");
			const plugins: RoundtablePlugin[] = [
				{
					name: "discord",
					useCommands: () => void log.push("commands"),
					agentServer: async () => void log.push("agent server"),
					...(preflight ? { preflight } : {}),
					setup: () => ({
						services: [recorded("surface", log)],
						interactions: [
							{
								module: { commands: () => [], handle: async () => false },
								rootOptions: [{ type: 1, name: "help", description: "help" }],
							},
						],
					}),
				},
				...(fail ? [{ name: "web", ...fail }] : []),
			];
			const { roundtable } = host(plugins, {
				commands: {
					root: {
						name: "roundtable",
						description: "control",
						contexts: [InteractionContextType.Guild],
					},
				},
				listeners: [{ id: "web", socketPath }],
			});
			return { roundtable, log, socketPath };
		};

		test("when a setup fails, as a web bundle that does not build", async () => {
			const { roundtable, log, socketPath } = failing({
				setup: async () => {
					throw new AggregateError([], "Bundle failed");
				},
			});
			expect(
				await roundtable.run().then(
					() => "ran",
					() => "failed",
				),
			).toBe("failed");
			expect(log).toEqual([]);
			expect(existsSync(socketPath)).toBe(false);
		});

		test("when the preflight fails", async () => {
			const { roundtable, log, socketPath } = failing(undefined, async () => {
				throw new Error("profile tools are not registered: memory_add");
			});
			expect(
				await roundtable.run().then(
					() => "ran",
					() => "failed",
				),
			).toBe("failed");
			expect(log).toEqual([]);
			expect(existsSync(socketPath)).toBe(false);
		});

		test("but a good one does, commands first and the listener last", async () => {
			const { roundtable, log, socketPath } = failing(undefined, async () => {
				log.push("preflight");
			});
			await roundtable.run();
			await Bun.sleep(5);
			expect(log).toEqual([
				"preflight",
				"commands",
				"start surface",
				"agent server",
			]);
			expect(existsSync(socketPath)).toBe(true);
			await roundtable.shutdown("SIGTERM");
		});
	});

	test("refuses overlapping routes before any service starts", async () => {
		const log: string[] = [];
		const route = (name: string) => ({
			name,
			listener: "web",
			path: { prefix: "/app/" },
			handle: () => new Response(name),
		});
		const { roundtable } = host(
			[
				{
					name: "a",
					setup: () => ({
						services: [recorded("a1", log)],
						http: [route("app"), route("app-again")],
					}),
				},
			],
			{ listeners: [{ id: "web", socketPath: "/nonexistent/web.sock" }] },
		);
		const error = await roundtable.run().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(PluginError);
		expect(log).toEqual([]);
	});
});
