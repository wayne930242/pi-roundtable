import type {
	ChannelContextAttachmentOptions,
	ChannelContextOptions,
} from "../contract/channel-context.ts";
import { MAX_TURN_IMAGES } from "../domain/attachment.ts";

/** The most bytes one image may be: the core's limit for any attachment. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/** The options with every default filled in, the attachments' too. */
export type ChannelContextSettings = Required<
	Omit<ChannelContextOptions, "attachments">
> & { attachments: Required<ChannelContextAttachmentOptions> };

/** The defaults of `ChannelContextOptions`. */
export const CHANNEL_CONTEXT_DEFAULTS: Readonly<
	Omit<Required<ChannelContextOptions>, "attachments"> & {
		attachments: Readonly<Required<ChannelContextAttachmentOptions>>;
	}
> = Object.freeze({
	fetch: 50,
	keep: 15,
	similarity: 0.8,
	messageChars: 500,
	botMessageChars: 80,
	peerMessageChars: 4_000,
	foreignWebhook: () => false,
	authors: () => undefined,
	starter: false,
	conversation: () => undefined,
	attachments: Object.freeze({ images: 0, maxBytes: 10 * 1024 * 1024 }),
});

/** The host's options, then the call's, over the defaults; the attachments' members merge one by one. */
export function resolvedSettings(
	host: ChannelContextOptions,
	call: ChannelContextOptions,
): ChannelContextSettings {
	const merged = {
		...CHANNEL_CONTEXT_DEFAULTS,
		...defined(host),
		...defined(call),
	};
	return {
		...merged,
		attachments: {
			...CHANNEL_CONTEXT_DEFAULTS.attachments,
			...defined(host.attachments ?? {}),
			...defined(call.attachments ?? {}),
		} as Required<ChannelContextAttachmentOptions>,
	};
}

/** Throws on a value outside what the configuration accepts: a programming error of the caller. */
export function assertChannelContextSettings(
	settings: ChannelContextSettings,
): void {
	const {
		fetch,
		keep,
		similarity,
		messageChars,
		botMessageChars,
		peerMessageChars,
	} = settings;
	const { images, maxBytes } = settings.attachments;
	const positive = {
		fetch,
		keep,
		messageChars,
		botMessageChars,
		peerMessageChars,
	};
	for (const [name, value] of Object.entries(positive))
		if (!Number.isInteger(value) || value < 1)
			throw new RangeError(
				`channel context option ${name} must be a positive integer, got ${value}`,
			);
	if (!(similarity >= 0 && similarity <= 1))
		throw new RangeError(
			`channel context option similarity must be between 0 and 1, got ${similarity}`,
		);
	if (typeof settings.foreignWebhook !== "function")
		throw new TypeError(
			"channel context option foreignWebhook must be a function",
		);
	if (typeof settings.authors !== "function")
		throw new TypeError("channel context option authors must be a function");
	if (typeof settings.starter !== "boolean")
		throw new TypeError("channel context option starter must be a boolean");
	if (typeof settings.conversation !== "function")
		throw new TypeError(
			"channel context option conversation must be a function",
		);
	if (!Number.isInteger(images) || images < 0 || images > MAX_TURN_IMAGES)
		throw new RangeError(
			`channel context option attachments.images must be an integer from 0 to ${MAX_TURN_IMAGES}, got ${images}`,
		);
	if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_IMAGE_BYTES)
		throw new RangeError(
			`channel context option attachments.maxBytes must be an integer from 1 to ${MAX_IMAGE_BYTES}, got ${maxBytes}`,
		);
}

/** The options that were given: a key set to undefined is the same as a missing one. */
function defined<T extends object>(options: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(options).filter(([, value]) => value !== undefined),
	) as Partial<T>;
}
