import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Interaction } from "discord.js";
import {
	definePlugin,
	IDENTITY,
	type InboundMessage,
	type Speaker,
} from "pi-roundtable";
import { channelQueue } from "pi-roundtable/kit";
import { fakeDiscord, servicePair, testPlugin } from "pi-roundtable/testing";
import { SandboxChannelStore } from "./channel-store.ts";
import { sandboxClaim } from "./claim.ts";
import { sandboxCommands } from "./commands.ts";
import { SANDBOX, sandbox } from "./plugin.ts";

const GUILD = "1479073413380440118";
const OTHER = "1381283461167317085";

function store(guilds?: readonly string[]): {
	channels: SandboxChannelStore;
	root: string;
} {
	const root = mkdtempSync(join(tmpdir(), "sb-guilds-"));
	return {
		root,
		channels: new SandboxChannelStore(join(root, "channels.json"), [], {
			guilds,
		}),
	};
}

test("a listed guild owns every channel it is asked about; others and unknown guilds do not", () => {
	const { channels, root } = store([GUILD]);
	try {
		expect(channels.owns("discord:1", GUILD)).toBe(true);
		expect(channels.owns("discord:2", OTHER)).toBe(false);
		expect(channels.owns("discord:3")).toBe(false);
		// Nothing is stored for a guild's channel; only an enabled one is on disk.
		expect(channels.has("discord:1")).toBe(false);
		expect(readFileSync(join(root, "channels.json"), "utf8")).toBe("[]");
		// A channel enabled by command is owned without a guild, as before.
		channels.enable("discord:4");
		expect(channels.owns("discord:4")).toBe(true);
		expect(channels.owns("discord:4", OTHER)).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a channel asked about with a listed guild is remembered for questions without one", () => {
	const { channels, root } = store([GUILD]);
	try {
		expect(channels.owns("discord:1")).toBe(false);
		channels.owns("discord:1", GUILD);
		channels.owns("discord:1", GUILD);
		expect(channels.owns("discord:1")).toBe(true);
		// A channel seen only in another guild is not remembered.
		channels.owns("discord:2", OTHER);
		expect(channels.owns("discord:2")).toBe(false);
		// Another surface's space is never a Discord guild.
		expect(channels.owns("mcp:5", GUILD)).toBe(false);
		expect(channels.owns("mcp:5")).toBe(false);
		// A fresh process knows nothing until a message arrives.
		expect(
			new SandboxChannelStore(join(root, "channels.json"), [], {
				guilds: [GUILD],
			}).owns("discord:1"),
		).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the remembered set holds 20,000 channels and drops the least recently seen", () => {
	const { channels, root } = store([GUILD]);
	try {
		for (let id = 1; id <= 20_000; id++) channels.owns(`discord:${id}`, GUILD);
		// Seeing the oldest again makes it the newest.
		channels.owns("discord:1", GUILD);
		channels.owns("discord:20001", GUILD);
		expect(channels.owns("discord:1")).toBe(true);
		expect(channels.owns("discord:2")).toBe(false);
		expect(channels.owns("discord:3")).toBe(true);
		expect(channels.owns("discord:20001")).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test.each([
	"",
	"guild",
	"123",
	"12345678901234567890123",
	"1479073413380440118 ",
])("guild id %p stops startup naming the option", (id) => {
	const root = mkdtempSync(join(tmpdir(), "sb-guilds-"));
	try {
		expect(
			() =>
				new SandboxChannelStore(join(root, "channels.json"), [], {
					guilds: [id],
				}),
		).toThrow("guilds");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

const served = servicePair(IDENTITY, {
	resolve: async (facts) =>
		facts.subject === "alice"
			? ({
					id: "alice",
					name: "Alice",
					tier: "member",
					principalId: "p_alice",
				} as Speaker)
			: undefined,
});
const message: InboundMessage = {
	channel: "discord:900",
	messageId: "one",
	authorId: "alice",
	authorName: "Alice",
	authorIsBot: false,
	isDirect: false,
	mentionsBot: true,
	repliesToBot: false,
	text: "Hello",
	attachments: [],
	space: GUILD,
};

async function claimHarness(guilds: readonly string[], runs: string[]) {
	const root = mkdtempSync(join(tmpdir(), "sb-guilds-"));
	const channels = new SandboxChannelStore(join(root, "c.json"), [], {
		guilds,
	});
	const replies: string[] = [];
	const harness = await testPlugin(
		definePlugin({
			name: "guild-claim",
			setup: (context) => ({
				channels: [
					sandboxClaim({
						channels,
						runtime: {
							runTurn: async (channel) => {
								runs.push(channel);
								return { ok: true, text: "Sealed." };
							},
							stop: () => true,
							startFresh: () => {},
						},
						surfaces: context.surfaces,
					}),
					{
						name: "host",
						priority: 100,
						owns: () => true,
						admit: () => {
							runs.push("host");
							return undefined;
						},
						startFresh: async () => "host",
					},
				],
			}),
		}),
		{
			services: [served],
			surfaces: [
				{
					surface: "discord",
					start: async () => {},
					sendReply: async (_channel, reply) => {
						replies.push(...reply.chunks);
					},
				},
			],
		},
	);
	return { harness, replies, root, channels };
}

test("a message in a listed guild reaches the sandbox, threads and new channels included, and never falls to the host", async () => {
	const runs: string[] = [];
	const { harness, replies, root } = await claimHarness([GUILD], runs);
	try {
		await harness.conversations.handle(message);
		await harness.conversations.handle({
			...message,
			channel: "discord:thread-1",
			messageId: "two",
		});
		await harness.conversations.handle({
			...message,
			mentionsBot: false,
			repliesToBot: true,
			channel: "discord:901",
			messageId: "three",
		});
		expect(runs).toEqual(["discord:900", "discord:thread-1", "discord:901"]);
		expect(replies).toEqual(["Sealed.", "Sealed.", "Sealed."]);
		// Without a guild, a remembered channel is still the sandbox's: stop answers true.
		expect(harness.conversations.stop("discord:900")).toBe(true);
		expect(await harness.conversations.startFresh("discord:900")).toBe(
			"sandbox",
		);
	} finally {
		await harness.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

test("answering rules are unchanged in a listed guild; other guilds and direct messages are not affected", async () => {
	const runs: string[] = [];
	const { harness, root } = await claimHarness([GUILD], runs);
	try {
		for (const override of [
			{ authorIsBot: true },
			{ integration: { id: "webhook", own: false } },
			{ mentionsBot: false, repliesToBot: false },
			{ authorId: "mallory", authorName: "Mallory" },
			{ space: OTHER },
			{ space: undefined },
			{ isDirect: true, space: undefined },
		])
			await harness.conversations.handle({ ...message, ...override });
		expect(runs.filter((entry) => entry !== "host")).toEqual([]);
	} finally {
		await harness.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

test("before a restart's first message nobody owns a configured guild's channel for stop and start fresh", async () => {
	const runs: string[] = [];
	const { harness, root } = await claimHarness([GUILD], runs);
	try {
		expect(harness.conversations.stop("discord:900")).toBe(false);
		await harness.conversations.handle(message);
		expect(harness.conversations.stop("discord:900")).toBe(true);
	} finally {
		await harness.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

function interaction(action: string, guildId: string | null = GUILD) {
	const replies: unknown[] = [];
	const fixture = {
		user: { id: "owner" },
		commandName: "roundtable",
		channelId: "900",
		guildId,
		deferred: false,
		replied: false,
		isAutocomplete: () => false,
		isChatInputCommand: () => true,
		isRepliable: () => true,
		inGuild: () => guildId !== null,
		options: {
			getSubcommandGroup: () => "sandbox",
			getSubcommand: () => action,
		},
		deferReply: async () => {
			fixture.deferred = true;
		},
		reply: async (body: unknown) => {
			replies.push(body);
		},
		editReply: async (body: unknown) => {
			replies.push(body);
		},
	};
	return { actor: fixture as unknown as Interaction, replies };
}

test("off is refused, on says it is already on and status names the configuration in a listed guild", async () => {
	const { channels, root } = store([GUILD]);
	try {
		const module = sandboxCommands(
			fakeDiscord().guard,
			channels,
			channelQueue(),
		).module;
		const off = interaction("off");
		await module.handle(off.actor);
		expect(off.replies).toEqual([
			"This server is sandboxed by configuration (`guilds`); change the configuration to turn it off.",
		]);
		const on = interaction("on");
		await module.handle(on.actor);
		expect(String(on.replies[0])).toContain("already on");
		expect(channels.has("discord:900")).toBe(false);
		const status = interaction("status");
		await module.handle(status.actor);
		expect(String(status.replies[0])).toContain("configuration");
		// Another guild keeps today's behavior.
		const elsewhere = interaction("on", OTHER);
		await module.handle(elsewhere.actor);
		expect(channels.has("discord:900")).toBe(true);
		await module.handle(interaction("off", OTHER).actor);
		expect(channels.has("discord:900")).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the plugin takes guilds, exposes SANDBOX.channels.owns and refuses an invalid id naming the option", async () => {
	const root = mkdtempSync("/tmp/sb-gplugin-");
	const options = (guilds: readonly string[]) =>
		sandbox({
			image: "sandbox:local",
			runRoot: join(root, "run"),
			workspaceRoot: join(root, "work"),
			stateFile: join(root, "state", "channels.json"),
			model: "fake",
			modelUrl: "https://models.example/v1/chat/completions",
			provider: "p",
			guilds,
			driver: { run: async () => ({ ok: true, text: "Safe." }) },
		});
	const surfaces = [
		{ surface: "discord", start: async () => {}, sendReply: async () => {} },
	];
	try {
		const harness = await testPlugin(options([GUILD]), {
			services: [served],
			apiKeys: { p: "key" },
			surfaces,
		});
		try {
			await harness.conversations.handle(message);
			expect(
				harness.contribution.channels?.[0]?.owns("discord:900", GUILD),
			).toBe(true);
			expect(harness.contribution.channels?.[0]?.owns("discord:77")).toBe(
				false,
			);
			expect(SANDBOX.id).toBe("sandbox.channels");
		} finally {
			await harness.stop();
		}
		await expect(
			testPlugin(options(["not-a-guild"]), {
				services: [served],
				apiKeys: { p: "key" },
				surfaces,
			}),
		).rejects.toThrow("guilds");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
