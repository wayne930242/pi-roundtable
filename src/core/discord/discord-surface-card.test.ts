import { afterEach, expect, spyOn, test } from "bun:test";
import { ChannelManager } from "discord.js";
import { silentLogger } from "../log.ts";
import { DiscordSurface } from "./discord-surface.ts";

afterEach(() => {
	// biome-ignore lint/suspicious/noExplicitAny: restores whatever spy a test left
	(ChannelManager.prototype.fetch as any).mockRestore?.();
});

function surface(warned: string[] = []): DiscordSurface {
	const logger = silentLogger();
	logger.warn = ((_fields: unknown, message: string) => {
		warned.push(message);
	}) as typeof logger.warn;
	return new DiscordSurface({
		token: "token",
		ownerId: "100",
		ownerName: "Ada",
		prompts: () => undefined,
		logger,
	});
}

test("a card Discord refuses is logged, and the reply's text still goes out", async () => {
	const sent: { content?: string; files?: unknown[] }[] = [];
	spyOn(ChannelManager.prototype, "fetch").mockResolvedValue({
		isSendable: () => true,
		send: async (options: { content?: string; files?: unknown[] }) => {
			if (options.files) throw new Error("Missing Permissions");
			sent.push(options);
		},
	} as never);
	const warned: string[] = [];
	await surface(warned).sendReply("discord:77", {
		card: new Uint8Array([1, 2, 3]),
		chunks: ["the answer"],
	});
	expect(sent.map((one) => one.content)).toEqual(["the answer"]);
	expect(warned).toEqual(["reply card not posted; sending the text alone"]);
});

test("a card that posts goes out before the text, as its own message", async () => {
	const sent: string[] = [];
	spyOn(ChannelManager.prototype, "fetch").mockResolvedValue({
		isSendable: () => true,
		send: async (options: { content?: string; files?: unknown[] }) => {
			sent.push(options.files ? "card" : (options.content ?? ""));
		},
	} as never);
	await surface().sendReply("discord:77", {
		card: new Uint8Array([1, 2, 3]),
		chunks: ["the answer"],
	});
	expect(sent).toEqual(["card", "the answer"]);
});
