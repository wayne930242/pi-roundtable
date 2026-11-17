import {
	type Client,
	type Message,
	PermissionFlagsBits,
	type TextBasedChannel,
} from "discord.js";
import type {
	CatchUpChannel,
	CatchUpReader,
	ScannedMessage,
} from "./catch-up.ts";
import { timeOf } from "./catch-up.ts";
import { toInbound } from "./inbound-message.ts";

/** What the bot needs in a server channel to read what was said there before. */
const READ = [
	PermissionFlagsBits.ViewChannel,
	PermissionFlagsBits.ReadMessageHistory,
];

/** Discord's error code for a member who is not in the server. */
const UNKNOWN_MEMBER = 10007;

function channelView(
	channel: TextBasedChannel,
): CatchUpChannel<Message & ScannedMessage> {
	return {
		id: channel.id,
		direct: channel.isDMBased(),
		lastMessageAt: channel.lastMessageId
			? timeOf(channel.lastMessageId)
			: undefined,
		read: async (before, limit) => [
			...(await channel.messages.fetch({ before, limit })).values(),
		],
	};
}

/**
 * Catch-up's view of a ready client. The server channels, threads and forum posts come from the
 * client's cache, which Discord fills as the connection becomes ready, with each channel's last
 * message: choosing what to read costs no request. A message's author is fetched as a member
 * before it is read in full, so its roles are those a live message carries; when that fails for
 * any reason but the author having left, the message is not read, so a later restart may retry it.
 */
export function clientCatchUpReader(
	client: Client,
): CatchUpReader<Message & ScannedMessage> {
	const bot = client.user;
	const readyAt = client.readyTimestamp;
	if (!bot || readyAt === null)
		throw new Error("catch-up needs a ready Discord connection");
	const identity = { botId: bot.id, applicationId: client.application?.id };
	return {
		botId: bot.id,
		applicationId: client.application?.id,
		readyAt,
		channels: () => {
			const found: CatchUpChannel<Message & ScannedMessage>[] = [];
			for (const channel of client.channels.cache.values()) {
				if (!channel.isTextBased()) continue;
				if (channel.isThread() && channel.archived) continue;
				if (!channel.isDMBased() && !channel.permissionsFor(bot)?.has(READ))
					continue;
				found.push(channelView(channel));
			}
			return found;
		},
		direct: async (channelId) => {
			const channel = await client.channels.fetch(channelId);
			return channel?.isDMBased() && channel.isTextBased()
				? channelView(channel)
				: undefined;
		},
		inbound: async (message) => {
			if (message.inGuild() && !message.member)
				await message.guild.members
					.fetch(message.author.id)
					.catch((error: unknown) => {
						// An author who left has no roles; any other failure leaves the message for a later restart.
						if ((error as { code?: unknown }).code !== UNKNOWN_MEMBER)
							throw error;
					});
			return toInbound(message, identity);
		},
	};
}

/** Posts `text` in a channel with no mention, as a notice; the posted message's id. */
export async function postNotice(
	client: Client,
	channelId: string,
	text: string,
): Promise<string> {
	const channel = await client.channels.fetch(channelId);
	if (!channel?.isSendable())
		throw new Error(`channel ${channelId} takes no message`);
	const posted = await channel.send({
		content: text,
		allowedMentions: { parse: [] },
	});
	return posted.id;
}
