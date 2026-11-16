import type { Client } from "discord.js";
import {
	type ContextSourceMessage,
	contextSourceOf,
} from "./channel-context.ts";

/** The identity channel context tells the assistant's posts by. */
function identityOf(client: Client<true>) {
	return { botId: client.user.id, applicationId: client.application.id };
}

/**
 * A server text channel's messages before one, as channel context reads them; undefined for a
 * direct message or a channel that holds no messages. Throws while the connection is not ready or
 * when Discord refuses, such as for a channel the bot cannot read.
 */
export async function readMessagesBefore(
	client: Client,
	channelId: string,
	before: string,
	limit: number,
): Promise<ContextSourceMessage[] | undefined> {
	if (!client.isReady()) throw new Error("Discord is not connected");
	const channel = await client.channels.fetch(channelId);
	if (!channel?.isTextBased() || channel.isDMBased()) return undefined;
	const fetched = await channel.messages.fetch({ before, limit });
	const self = identityOf(client);
	return [...fetched.values()].map((message) => contextSourceOf(message, self));
}

/**
 * The opening message of a thread: a forum post's first message (its id is the thread's) or the
 * message in the parent channel a text channel's thread was started from; undefined for a channel
 * that is not a thread, and for a thread without one (a private thread, a deleted starter).
 * Throws while the connection is not ready or when Discord refuses for another reason.
 */
export async function readThreadStarter(
	client: Client,
	channelId: string,
): Promise<ContextSourceMessage | undefined> {
	if (!client.isReady()) throw new Error("Discord is not connected");
	const channel = await client.channels.fetch(channelId);
	if (!channel?.isThread()) return undefined;
	let starter: Awaited<ReturnType<typeof channel.fetchStarterMessage>>;
	try {
		starter = await channel.fetchStarterMessage();
	} catch (error) {
		// Unknown Message (10008): the starter was deleted; a thread made without a message has no
		// starter, which discord.js reports the same way.
		if (isMissing(error)) return undefined;
		throw error;
	}
	return starter ? contextSourceOf(starter, identityOf(client)) : undefined;
}

/** Discord's "Unknown Message" (10008) or "Unknown Channel" (10003): there is nothing to read. */
function isMissing(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	return code === 10008 || code === 10003;
}
