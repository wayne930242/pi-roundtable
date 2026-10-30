import { afterEach, expect, spyOn, test } from "bun:test";
import { ChannelManager } from "discord.js";
import { silentLogger } from "../log.ts";
import { DiscordSurface } from "./discord-surface.ts";

const PEER = "800000000000000001";

afterEach(() => {
	// biome-ignore lint/suspicious/noExplicitAny: restores whatever spy a test left
	(ChannelManager.prototype.fetch as any).mockRestore?.();
});

test("a reply pings the users its text names, so a peer bot it mentions is notified", async () => {
	const sent: { content?: string; allowedMentions?: unknown }[] = [];
	spyOn(ChannelManager.prototype, "fetch").mockResolvedValue({
		isSendable: () => true,
		send: async (options: { content?: string; allowedMentions?: unknown }) => {
			sent.push(options);
		},
	} as never);
	const surface = new DiscordSurface({
		token: "token",
		ownerId: "100",
		ownerName: "Ada",
		prompts: () => undefined,
		logger: silentLogger(),
	});
	await surface.sendReply("discord:77", { chunks: [`<@${PEER}> your turn`] });
	expect(sent).toEqual([
		{ content: `<@${PEER}> your turn`, allowedMentions: { parse: ["users"] } },
	]);
});
