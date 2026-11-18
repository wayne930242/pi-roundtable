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
const TEXT_CHANNEL = "600000000000000002";
/** A message of a text channel, such as a crosspost's source, that a reply in the post quotes. */
const ELSEWHERE = { channelId: TEXT_CHANNEL, messageId: "500000000000000001" };
/** The post's starter, which shares the post's id and is in the post. */
const STARTER = { channelId: POST, messageId: POST };

/** A person's reply in the forum post `POST` to the message `quoted`, which carries one file. */
function reply(quoted: { channelId: string; messageId: string }) {
	const { channelId, messageId } = quoted;
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
			messageId,
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
	client.emit(Events.MessageCreate, reply(STARTER));
	client.emit(Events.MessageCreate, reply(ELSEWHERE));
	await Bun.sleep(5);
	expect(
		delivered.map((message) => [message.channel, message.reference?.channel]),
	).toEqual([
		[`discord:${POST}`, `discord:${POST}`],
		[`discord:${POST}`, `discord:${TEXT_CHANNEL}`],
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
	const own = await reader.inbound(reply(STARTER) as never);
	const other = await reader.inbound(reply(ELSEWHERE) as never);
	expect(own?.reference?.channel).toBe(`discord:${POST}`);
	expect(own?.reference?.channel).toBe(own?.channel);
	expect(other?.reference?.channel).toBe(`discord:${TEXT_CHANNEL}`);
});
