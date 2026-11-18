import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
	ChannelType,
	type Client,
	Events,
	MessageReferenceType,
} from "discord.js";
import type { InboundMessage } from "../contract/channels.ts";
import { silentLogger } from "../kernel/log.ts";
import { clientCatchUpReader } from "./catch-up-reader.ts";
import { listenForMessages } from "./message-changes.ts";

const BOT = "900000000000000009";
const POST = "700000000000000001";
const FORUM_CHANNEL = "600000000000000001";

/**
 * A person's reply in a forum post, `POST`, to a message in `channelId`: the post's starter shares
 * the post's id and channel, while a message of another channel is one Discord let them reply to
 * from elsewhere.
 */
function reply(channelId: string) {
	return {
		id: "m1",
		channelId: POST,
		guildId: "g1",
		content: `<@${BOT}> please look`,
		author: { id: "1", bot: false, username: "ada", globalName: "Ada" },
		member: null,
		webhookId: null,
		applicationId: null,
		reference: {
			type: MessageReferenceType.Default,
			channelId,
			guildId: "g1",
			messageId: POST,
		},
		fetchReference: async () => ({
			channelId,
			author: { id: "2", username: "bo" },
			content: "the starter",
			webhookId: null,
			attachments: new Map([
				[
					"a1",
					{
						id: "a1",
						url: "https://files/spec.pdf",
						name: "spec.pdf",
						size: 1,
					},
				],
			]),
			embeds: [],
		}),
		messageSnapshots: { first: () => undefined },
		mentions: { users: new Map([[BOT, {}]]) },
		channel: {
			isDMBased: () => false,
			isThread: () => true,
			parentId: FORUM_CHANNEL,
			parent: { type: ChannelType.GuildForum },
		},
		attachments: new Map(),
		embeds: [],
		inGuild: () => false,
	};
}

test("a live reply carries the replied-to message's channel, so a claim tells a post's own starter from another channel's message", async () => {
	const client = Object.assign(new EventEmitter(), {
		user: { id: BOT },
		application: { id: BOT },
	});
	const delivered: InboundMessage[] = [];
	listenForMessages(
		client as unknown as Client,
		(message) => delivered.push(message),
		silentLogger(),
	);
	client.emit(Events.MessageCreate, reply(POST));
	client.emit(Events.MessageCreate, reply(FORUM_CHANNEL));
	await Bun.sleep(5);
	expect(
		delivered.map((message) => [message.channel, message.reference?.channel]),
	).toEqual([
		[`discord:${POST}`, `discord:${POST}`],
		[`discord:${POST}`, `discord:${FORUM_CHANNEL}`],
	]);
	expect(delivered[0]?.reference?.attachments.map((file) => file.name)).toEqual(
		["spec.pdf"],
	);
});

test("a reply caught up after a restart carries the replied-to message's channel as a live one does", async () => {
	const client = {
		user: { id: BOT },
		application: { id: BOT },
		readyTimestamp: Date.parse("2026-11-18T07:00:00Z"),
		channels: { cache: new Map() },
	};
	const reader = clientCatchUpReader(client as unknown as Client);
	const own = await reader.inbound(reply(POST) as never);
	const other = await reader.inbound(reply(FORUM_CHANNEL) as never);
	expect(own?.reference?.channel).toBe(`discord:${POST}`);
	expect(own?.reference?.channel).toBe(own?.channel);
	expect(other?.reference?.channel).toBe(`discord:${FORUM_CHANNEL}`);
});
