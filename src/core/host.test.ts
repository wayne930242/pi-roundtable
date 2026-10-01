import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type {
	ChannelClaim,
	ConversationPort,
	InboundMessage,
} from "./contract/channels.ts";
import type { ChatSurface } from "./contract/surface.ts";
import { NotLinkedError, PluginError } from "./errors.ts";
import type { HoldRule } from "./holds.ts";
import { Roundtable, type RoundtableOptions } from "./host.ts";
import { silentLogger } from "./log.ts";
import type { LinkedSessions, RoundtablePlugin, Service } from "./plugin.ts";
import type { SessionTool } from "./sessions.ts";

/** A chat surface that connects to nothing; `extra` adds what a test observes. */
function quietSurface(
	prefix: string,
	extra: Partial<ChatSurface> = {},
): ChatSurface {
	return {
		surface: prefix,
		start: async () => undefined,
		sendReply: async () => undefined,
		...extra,
	};
}

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

/** Every host of the test, so one that a test leaves running never blocks the next: one runs per process. */
const hosts: Roundtable[] = [];
afterEach(async () => {
	for (const roundtable of hosts.splice(0)) await roundtable.shutdown("test");
});

function host(
	plugins: RoundtablePlugin[],
	options: Partial<RoundtableOptions> = {},
): { roundtable: Roundtable } {
	const roundtable = new Roundtable(
		{
			logger: silentLogger(),
			drain: { intervalMs: 1, limitMs: 50 },
			...options,
		},
		plugins,
	);
	hosts.push(roundtable);
	return { roundtable };
}

describe("Roundtable", () => {
	test("starts services in registration order and stops them in reverse", async () => {
		const log: string[] = [];
		const { roundtable } = host([
			plugin("a", [recorded("a1", log), recorded("a2", log)]),
			plugin("b", [recorded("b1", log)]),
		]);
		await roundtable.run();
		const code = await roundtable.shutdown("SIGTERM");
		expect(log).toEqual([
			"start a1",
			"start a2",
			"start b1",
			"stop b1",
			"stop a2",
			"stop a1",
		]);
		expect(code).toBe(0);
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
		const { roundtable } = host(
			[plugin("a", [{ name: "a1", busy: () => ["discord:1", "discord:2"] }])],
			{
				aborted: async (left) => {
					aborted.push(left);
				},
			},
		);
		await roundtable.run();
		const code = await roundtable.shutdown("SIGTERM");
		expect(aborted).toEqual([["discord:1", "discord:2"]]);
		expect(code).toBe(0);
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

	test("serves HTTP only while every service runs", async () => {
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
					setup: () => ({
						surfaces: [quietSurface("chat", {})],
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
			{ listeners: [{ id: "web", socketPath }] },
		);
		await roundtable.run();
		log.push(`running: ${await get()}`);
		await roundtable.shutdown("SIGTERM");
		expect(log).toEqual([
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
				setup: (context) => {
					conversations = context.conversations;
					expect(() => context.conversations.stop("discord:1")).toThrow(
						NotLinkedError,
					);
					return { channels: [claim("owner", 0)] };
				},
			},
			{ name: "open", setup: () => ({ channels: [claim("open", 20)] }) },
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
		expect(log).toEqual(["open hi"]);
		// The open claim owns the channel and has no `stop`, so the owner claim below it is not asked.
		expect(conversations?.stop("discord:1")).toBe(false);
	});

	test("stops a channel's turn through the claim that owns it, and only that claim", async () => {
		const asked: string[] = [];
		const claim = (
			name: string,
			priority: number,
			owns: (channel: string) => boolean,
			stop?: ChannelClaim["stop"],
		): ChannelClaim => ({
			name,
			priority,
			owns,
			admit: () => undefined,
			startFresh: async () => name,
			...(stop ? { stop } : {}),
		});
		let conversations: ConversationPort | undefined;
		const { roundtable } = host([
			{
				name: "claims",
				setup: (context) => {
					conversations = context.conversations;
					return {
						channels: [
							claim(
								"agents",
								30,
								(c) => c === "discord:1",
								(c) => {
									asked.push(`agents ${c}`);
									return true;
								},
							),
							// Owns its channel but has no `stop`.
							claim("quiet", 20, (c) => c === "quiet:1"),
							claim(
								"owner",
								0,
								() => true,
								(c) => {
									asked.push(`owner ${c}`);
									return c === "discord:2";
								},
							),
						],
					};
				},
			},
		]);
		await roundtable.run();
		expect(conversations?.stop("discord:1")).toBe(true);
		expect(conversations?.stop("discord:2")).toBe(true);
		expect(conversations?.stop("discord:3")).toBe(false);
		// A claim without `stop` means false, and a lower claim that has one is not asked instead.
		expect(conversations?.stop("quiet:1")).toBe(false);
		expect(asked).toEqual([
			"agents discord:1",
			"owner discord:2",
			"owner discord:3",
		]);
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

	test("gives a plugin the credential the host's login holds, and none when the host has none", async () => {
		const read: Record<string, string | undefined> = {};
		const reader: RoundtablePlugin = {
			name: "reader",
			setup: async ({ apiKey }) => {
				read.known = await apiKey("openai-codex");
				read.unknown = await apiKey("nobody");
				return { dashboard: ["keys"] };
			},
		};
		const { roundtable } = host([reader], {
			apiKey: async (provider) =>
				provider === "openai-codex" ? "key-1" : undefined,
		});
		await roundtable.run();
		expect(read).toEqual({ known: "key-1", unknown: undefined });
		await roundtable.shutdown("test");
		const bare: Record<string, string | undefined> = {};
		const { roundtable: without } = host([
			{
				name: "bare",
				setup: async ({ apiKey }) => {
					bare.known = await apiKey("openai-codex");
					return { dashboard: ["keys"] };
				},
			},
		]);
		await without.run();
		expect(bare).toEqual({ known: undefined });
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
					...(preflight ? { preflight } : {}),
					setup: () => ({
						surfaces: [
							quietSurface("discord", {
								start: async () => void log.push("start surface"),
							}),
						],
						services: [
							{
								name: "background",
								startInBackground: async () => void log.push("background"),
							},
						],
					}),
				},
				...(fail ? [{ name: "web", ...fail }] : []),
			];
			const { roundtable } = host(plugins, {
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
				throw new Error("required tools are not registered: memory_add");
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

		test("but a good one does, the preflight first and the listener last", async () => {
			const { roundtable, log, socketPath } = failing(undefined, async () => {
				log.push("preflight");
			});
			await roundtable.run();
			await Bun.sleep(5);
			expect(log).toEqual(["preflight", "start surface", "background"]);
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

	test("logs and drops a message a surface delivers under another prefix, and keeps delivering its own", async () => {
		const lines: string[] = [];
		const logger = pino(
			{ level: "error" },
			{ write: (line) => void lines.push(line) },
		);
		let deliver: ((message: InboundMessage) => void) | undefined;
		const heard: string[] = [];
		const claim: ChannelClaim = {
			name: "all",
			priority: 0,
			owns: () => true,
			admit: (message) => ({
				kind: "turn",
				run: async () => void heard.push(message.channel),
				failure: "failed",
			}),
			startFresh: async () => "chat",
		};
		const { roundtable } = host(
			[
				{
					name: "chat",
					setup: () => ({
						channels: [claim],
						surfaces: [
							quietSurface("chat", {
								start: async (delivery) => {
									deliver = delivery;
								},
							}),
						],
					}),
				},
			],
			{ logger },
		);
		await roundtable.run();
		const message = (channel: InboundMessage["channel"]): InboundMessage => ({
			channel,
			messageId: "m",
			authorId: "1",
			authorName: "Ada",
			authorIsBot: false,
			isDirect: true,
			mentionsBot: false,
			repliesToBot: false,
			text: "hi",
			attachments: [],
		});
		deliver?.(message("discord:1"));
		deliver?.(message("chat:1"));
		await Bun.sleep(10);
		expect(heard).toEqual(["chat:1"]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("another prefix");
		expect(lines[0]).toContain("discord:1");
	});
});
