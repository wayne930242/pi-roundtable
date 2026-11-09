import { afterEach, describe, expect, test } from "bun:test";
import { hasWebAccess } from "./core/testing/test-host.ts";
import { DISCORD } from "./discord/index.ts";
import {
	AGENTS,
	type AgentServer,
	type AgentTeam,
	type ChannelKey,
	definePlugin,
	type InboundMessage,
	type Judge,
	type PendingConfirmation,
} from "./index.ts";
import {
	describeDb,
	partial,
	recordingLogger,
	servicePair,
	type TestHost,
	testHost,
	testPlugin,
} from "./testing.ts";

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
