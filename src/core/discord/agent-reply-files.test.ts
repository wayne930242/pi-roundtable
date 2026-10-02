import { expect, test } from "bun:test";
import {
	ChannelType,
	type Client,
	type WebhookMessageCreateOptions,
} from "discord.js";
import { DiscordAgentChannels } from "./agent-discord.ts";

test("Discord posts text and files through the same agent webhook identity, never a bot send", async () => {
	const sent: WebhookMessageCreateOptions[] = [];
	const webhook = {
		send: async (payload: WebhookMessageCreateOptions) => {
			sent.push(payload);
		},
	};
	const client = {
		channels: {
			fetch: async () => ({
				type: ChannelType.GuildText,
				fetchWebhooks: async () => ({ find: () => undefined }),
				createWebhook: async () => webhook,
				send: async () => {
					throw new Error("Must not post as the bot.");
				},
			}),
		},
	} as unknown as Client;
	const channels = new DiscordAgentChannels(client, "guild");
	const identity = {
		name: "Artist",
		avatarUrl: "https://example.com/avatar.png",
	};
	await channels.post("room", {
		...identity,
		chunks: ["Here is the image."],
		files: [{ name: "image.png", data: new Uint8Array([1, 2, 3]) }],
	});
	expect(sent).toHaveLength(2);
	for (const payload of sent) {
		expect(payload.username).toBe(identity.name);
		expect(payload.avatarURL).toBe(identity.avatarUrl);
	}
	expect(sent[0]?.content).toBe("Here is the image.");
	expect(sent[1]?.files).toHaveLength(1);
	const upload = sent[1]?.files?.[0];
	expect(
		upload && typeof upload === "object" && "name" in upload && upload.name,
	).toBe("image.png");
});
