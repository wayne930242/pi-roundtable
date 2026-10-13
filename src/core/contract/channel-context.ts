import {
	MAX_TURN_IMAGES,
	type ModelImage,
	type TurnAttachments,
} from "../domain/attachment.ts";

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
	/**
	 * Whether a post through a webhook of the assistant's own application is another author's, not
	 * the assistant's. `webhookId` is the webhook's id; when this returns true the post is kept as a
	 * message of a bot named by the post's username, and does not end the window, so people a
	 * plugin mirrors into the channel through a webhook of its own are read. The assistant's own
	 * posts, which end the window, stay its bot user and every webhook this returns false for, such
	 * as an agent's voice. Default: none, every webhook of the application is the assistant's.
	 *
	 * `"skip"` is for a webhook that is neither: one the plugin posts its own status notices
	 * through. A post through it is dropped from the context and does not end the window, as if it
	 * were not in the channel; it is not another author's words and not the assistant's answer.
	 * Only `true` and `"skip"` change anything; any other answer reads as false.
	 */
	foreignWebhook?: (webhookId: string) => boolean | "skip";
	/** Which attachments of the kept messages are fetched for the turn; none by default. */
	attachments?: ChannelContextAttachmentOptions;
}

/** What `ChannelContextOptions.attachments` asks of the images in the kept messages. */
export interface ChannelContextAttachmentOptions {
	/**
	 * How many images are fetched, at most, the newest first; default 0, none. At most 4, as many
	 * as a turn carries. A PNG, JPEG, GIF or WebP that cannot be fetched, is larger than
	 * `maxBytes`, or cannot be decoded is skipped and named in its message's text.
	 */
	images?: number;
	/** The most bytes of one image fetched; default 10 MiB, at most 25 MiB. */
	maxBytes?: number;
}

/** A file attached to a channel message, as Discord describes it; its bytes are not fetched by this. */
export interface ChannelContextAttachment {
	name: string;
	/** Empty when Discord does not say. */
	contentType: string;
	/** Bytes, as Discord reports. */
	size: number;
	url: string;
	/** The message it is attached to. */
	messageId: string;
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
	/** The files attached to it, whether or not their bytes were fetched; always present on what the core returns. */
	attachments?: readonly ChannelContextAttachment[];
}

/**
 * What was said in a server channel since the assistant last posted there, before the message that
 * addressed it: public channel text, not anyone's private memory, and not from the turn's speaker.
 */
export interface ChannelContext {
	/** Oldest first; never empty. */
	readonly messages: readonly ChannelContextMessage[];
	/** The delimited block `withChannelContext` appends to a turn's text; it says nothing of images, `withChannelContext` adds that. */
	readonly text: string;
	/**
	 * The images of the messages, newest first, as `TurnAttachments.images`: fetched for the call
	 * when `ChannelContextOptions.attachments.images` asked for some, prepared as a turn's own
	 * images are, and never stored or logged; absent or empty otherwise. Pass them to the turn with
	 * `withChannelContextImages`.
	 */
	readonly images?: readonly ModelImage[];
}

/** What the turn is told when channel context images are among its images. */
const CONTEXT_IMAGES_NOTE =
	"Pictures posted in the channel messages above are shown to you among this turn's images, the newest first.";

/**
 * The turn's text, then its channel context when there is one, as `withReference` adds a replied-to
 * message. `imagesKept` is how many of the context's images the turn carries, as
 * `withChannelContextImages` reports; above zero the block says so, and it never does otherwise.
 */
export function withChannelContext(
	text: string,
	context: ChannelContext | undefined,
	imagesKept = 0,
): string {
	if (!context) return text;
	return `${text}\n\n${context.text}${imagesKept > 0 ? `\n${CONTEXT_IMAGES_NOTE}` : ""}`;
}

/**
 * The turn's attachments with the context's images after its own, at most as many images as a turn
 * carries (4); the turn's own images come first and are never displaced, so a turn that already
 * carries four takes none, and an image crowded out is not noted anywhere. `kept` is how many of
 * the context's images made it, the newest first; give it to `withChannelContext` so the block says
 * so only for images the turn has. The attachments are untouched without a context or images.
 */
export function withChannelContextImages(
	attachments: TurnAttachments,
	context: ChannelContext | undefined,
): { attachments: TurnAttachments; kept: number } {
	const more = context?.images ?? [];
	if (more.length === 0) return { attachments, kept: 0 };
	const images = [...attachments.images, ...more].slice(0, MAX_TURN_IMAGES);
	return {
		attachments: { ...attachments, images },
		kept: Math.max(0, images.length - attachments.images.length),
	};
}
