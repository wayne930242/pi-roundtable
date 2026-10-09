// What a surface tells a turn about the channel around the message it answers. Discord fills it
// (`DISCORD.channelContext`); the types and the way a turn carries it are any surface's.

/** How much of a channel a turn reads as its channel context; every member has a default. */
export interface ChannelContextOptions {
	/** How many messages before the addressed one are fetched; default 50, at most 100 (Discord's page). */
	fetch?: number;
	/** How many of the window's messages are kept, the newest; default 15. */
	keep?: number;
	/**
	 * How alike (0 to 1) two consecutive messages of one author must be to count as one, the later
	 * kept, such as a message and its corrected repost; default 0.8.
	 */
	similarity?: number;
	/** Where a message's text is cut; default 500 characters. */
	messageChars?: number;
	/** Where another bot's message is cut; default 80 characters. */
	botMessageChars?: number;
}

/** One channel message a turn reads around the message that addressed the assistant. */
export interface ChannelContextMessage {
	id: string;
	authorId: string;
	/** How the author appears in the channel. */
	authorName: string;
	/** Another bot, or an integration such as a webhook that is not the assistant's. */
	bot: boolean;
	/** One of the host's owners. */
	owner: boolean;
	/** The text, with mentions by name and stickers and files as text, cut where the options say. */
	text: string;
	at: Date;
}

/**
 * What was said in a server channel since the assistant last posted there, before the message that
 * addressed it: public channel text, not anyone's private memory, and not from the turn's speaker.
 */
export interface ChannelContext {
	/** Oldest first; never empty. */
	readonly messages: readonly ChannelContextMessage[];
	/** The delimited block `withChannelContext` appends to a turn's text. */
	readonly text: string;
}

/** The turn's text, then its channel context when there is one, as `withReference` adds a replied-to message. */
export function withChannelContext(
	text: string,
	context: ChannelContext | undefined,
): string {
	return context ? `${text}\n\n${context.text}` : text;
}
