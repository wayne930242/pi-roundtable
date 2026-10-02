import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin, type InboundMessage } from "pi-roundtable";
import { fakeDiscord, testPlugin } from "pi-roundtable/testing";
import { SandboxChannelStore } from "./channel-store.ts";
import { sandboxClaim } from "./claim.ts";
import { SANDBOX, sandbox } from "./plugin.ts";

const message: InboundMessage = {
	channel: "fake:guests",
	messageId: "one",
	authorId: "alice",
	authorName: "Alice",
	authorIsBot: false,
	isDirect: false,
	mentionsBot: true,
	repliesToBot: false,
	text: "Hello",
	attachments: [],
};

test("claim routes guests and owners only into its own runtime and never falls through to a priority-100 host claim", async () => {
	let hostCalls = 0;
	let sandboxCalls = 0;
	const replies: string[] = [];
	const plugin = definePlugin({
		name: "claim-test",
		setup: (context) => ({
			channels: [
				sandboxClaim({
					channels: { has: (channel) => channel === "fake:guests" },
					runtime: {
						runTurn: async (_channel, speaker) => {
							sandboxCalls++;
							expect(["alice", "owner"]).toContain(speaker.id);
							return { ok: true, text: "Sealed." };
						},
						stop: () => true,
						startFresh: () => {},
					},
					surfaces: context.surfaces,
				}),
				{
					name: "host-fallback",
					priority: 100,
					owns: () => true,
					admit: () => ({
						kind: "turn",
						failure: "unexpected host call",
						run: async () => {
							hostCalls++;
						},
					}),
					startFresh: async () => "host",
				},
			],
		}),
	});
	const harness = await testPlugin(plugin, {
		surfaces: [
			{
				surface: "fake",
				start: async () => {},
				sendReply: async (_channel, reply) => {
					replies.push(...reply.chunks);
				},
			},
		],
	});
	try {
		await harness.conversations.handle(message);
		await harness.conversations.handle({ ...message, authorId: "owner" });
		for (const override of [
			{ authorIsBot: true },
			{ isDirect: true },
			{ integration: { id: "webhook", own: false } },
			{ mentionsBot: false, repliesToBot: false },
		])
			await harness.conversations.handle({ ...message, ...override });
		await harness.conversations.handle({
			...message,
			mentionsBot: false,
			repliesToBot: true,
		});
		expect(sandboxCalls).toBe(3);
		expect(hostCalls).toBe(0);
		expect(replies).toEqual(["Sealed.", "Sealed.", "Sealed."]);
		expect(await harness.conversations.startFresh(message.channel)).toBe(
			"sandbox",
		);
		expect(harness.conversations.stop(message.channel)).toBe(true);
	} finally {
		await harness.stop();
	}
});

test("routing state survives restarts and malformed state fails closed", () => {
	const root = mkdtempSync(join(tmpdir(), "sb-state-"));
	try {
		const path = join(root, "channels.json");
		const channels = new SandboxChannelStore(path);
		channels.enable("fake:guests");
		expect(new SandboxChannelStore(path).has("fake:guests")).toBe(true);
		channels.disable("fake:guests");
		expect(new SandboxChannelStore(path).has("fake:guests")).toBe(false);
		expect(() => channels.enable("bad" as `fake:${string}`)).toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("package plugin uses public API, contributes guarded commands, and sends no credential or host settings to driver", async () => {
	const root = mkdtempSync("/tmp/sb-plugin-");
	const discord = fakeDiscord();
	let calls = 0;
	const harness = await testPlugin(
		sandbox({
			image: "sandbox:local",
			runRoot: join(root, "run"),
			workspaceRoot: join(root, "work"),
			stateFile: join(root, "state", "channels.json"),
			initialChannels: ["fake:guests"],
			model: "fake",
			modelUrl: "https://models.example/v1/chat/completions",
			provider: "test-provider",
			driver: {
				run: async (spec, turn) => {
					calls++;
					expect(JSON.stringify({ spec, turn })).not.toContain("real-test-key");
					expect(turn.timeZone).toBe("Europe/London");
					expect(turn.speaker.id).toBe("alice");
					expect(spec.runDir).not.toBe(spec.workspaceDir);
					return { ok: true, text: "Safe." };
				},
			},
		}),
		{
			services: [discord.service],
			apiKeys: { "test-provider": "real-test-key" },
			env: { timeZone: "Europe/London" },
			surfaces: [
				{ surface: "fake", start: async () => {}, sendReply: async () => {} },
			],
		},
	);
	try {
		await harness.conversations.handle(message);
		expect(calls).toBe(1);
		expect(
			discord
				.compose()
				.commands.find((command) => command.name === "roundtable")
				?.options?.some((option) => option.name === "sandbox"),
		).toBe(true);
		expect(SANDBOX.id).toBe("sandbox.channels");
		expect(harness.contribution.channels?.[0]?.owns(message.channel)).toBe(
			true,
		);
		expect(
			readFileSync(join(root, "state", "channels.json"), "utf8"),
		).toContain("fake:guests");
	} finally {
		await harness.stop();
		rmSync(root, { recursive: true, force: true });
	}
});
