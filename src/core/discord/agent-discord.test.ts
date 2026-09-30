import { describe, expect, test } from "bun:test";
import { ChannelType, type Client } from "discord.js";
import { silentLogger } from "../log.ts";
import { DiscordDashboard } from "./agent-discord.ts";

const BOT = "900";

/** A dashboard channel in a fake server whose one bot message may already be pinned. */
function fixture(options: { pinned: boolean; pinFails?: boolean }) {
	const pins: string[] = [];
	const message = {
		id: "m1",
		pinned: options.pinned,
		author: { id: BOT },
		channel: { messages: { fetch: async () => message } },
		edit: async () => message,
		pin: async () => {
			if (options.pinFails) throw new Error("Missing Permissions");
			pins.push("m1");
		},
	};
	const channel = {
		type: ChannelType.GuildText,
		name: "dashboard",
		parentId: null,
		topic: null,
		setTopic: async () => undefined,
		messages: {
			fetch: async () => ({
				find: (match: (m: typeof message) => boolean) => [message].find(match),
			}),
		},
	};
	channel.topic = null;
	const client = {
		user: { id: BOT },
		guilds: {
			fetch: async () => ({
				channels: {
					fetch: async () => ({
						find: (match: (c: typeof channel) => boolean) =>
							[channel].find(match),
					}),
				},
			}),
		},
	} as unknown as Client;
	return { pins, dashboard: new DiscordDashboard(client, "1", silentLogger()) };
}

describe("DiscordDashboard pinning", () => {
	test("an existing unpinned message is pinned once, however often it is updated", async () => {
		const { dashboard, pins } = fixture({ pinned: false });
		await dashboard.show(["a"]);
		await dashboard.show(["b"]);
		expect(pins).toEqual(["m1"]);
	});

	test("an already pinned message is left alone", async () => {
		const { dashboard, pins } = fixture({ pinned: true });
		await dashboard.show(["a"]);
		expect(pins).toEqual([]);
	});

	test("a refused pin does not stop the update", async () => {
		const { dashboard } = fixture({ pinned: false, pinFails: true });
		await dashboard.show(["a"]);
		await dashboard.show(["b"]);
	});
});
