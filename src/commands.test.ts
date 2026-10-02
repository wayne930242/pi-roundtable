import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Interaction } from "discord.js";
import { channelQueue } from "pi-roundtable/kit";
import { fakeDiscord } from "pi-roundtable/testing";
import { SandboxChannelStore } from "./channel-store.ts";
import { sandboxCommands } from "./commands.ts";

function interaction(
	userId: string,
	action: string,
	guild = true,
): { actor: Interaction; replies: unknown[] } {
	const replies: unknown[] = [];
	const fixture = {
		user: { id: userId },
		commandName: "roundtable",
		channelId: "guest-channel",
		deferred: false,
		replied: false,
		isAutocomplete: () => false,
		isChatInputCommand: () => true,
		isRepliable: () => true,
		inGuild: () => guild,
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
	// SAFETY: this fixture supplies every method read by ownerCommandModule/guard and sandboxCommands; no Discord transport is used.
	return { actor: fixture as unknown as Interaction, replies };
}

test("owner-only commands persist on/off, report status and refuse guests and direct messages", async () => {
	const root = mkdtempSync("/tmp/sb-commands-");
	try {
		const channels = new SandboxChannelStore(join(root, "channels.json"));
		const module = sandboxCommands(
			fakeDiscord().guard,
			channels,
			channelQueue(),
		).module;
		const guest = interaction("guest", "on");
		expect(await module.handle(guest.actor)).toBe(true);
		expect(channels.has("discord:guest-channel")).toBe(false);
		expect(guest.replies.length).toBe(1);
		const direct = interaction("owner", "on", false);
		await module.handle(direct.actor);
		expect(channels.has("discord:guest-channel")).toBe(false);
		const owner = interaction("owner", "on");
		await module.handle(owner.actor);
		expect(channels.has("discord:guest-channel")).toBe(true);
		expect(owner.replies).toEqual([
			"Sandbox routing is enabled. Mention the bot or reply to it to start a sealed turn.",
		]);
		const status = interaction("owner", "status");
		await module.handle(status.actor);
		expect(String(status.replies[0])).toContain("enabled");
		await module.handle(interaction("owner", "off").actor);
		expect(
			new SandboxChannelStore(join(root, "channels.json")).has(
				"discord:guest-channel",
			),
		).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("mode changes wait behind the shared channel turn queue", async () => {
	const root = mkdtempSync("/tmp/sb-commands-");
	try {
		const channels = new SandboxChannelStore(join(root, "channels.json"), [
			"discord:guest-channel",
		]);
		const queue = channelQueue();
		let finish: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const turn = queue.run("discord:guest-channel", async () => gate);
		const command = sandboxCommands(
			fakeDiscord().guard,
			channels,
			queue,
		).module.handle(interaction("owner", "off").actor);
		await Promise.resolve();
		expect(channels.has("discord:guest-channel")).toBe(true);
		finish?.();
		await turn;
		await command;
		expect(channels.has("discord:guest-channel")).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
