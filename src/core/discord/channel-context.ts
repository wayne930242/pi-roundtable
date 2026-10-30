import type { Message } from "discord.js";
import {
	type ChannelContext,
	type ChannelContextAttachmentOptions,
	type ChannelContextMessage,
	type ChannelContextOptions,
	type ChannelContextSource,
	type ChannelContextSourceAttachment,
	type ChannelContextVerdict,
	formatChannelContext,
} from "../contract/channel-context.ts";
import type { InboundMessage } from "../contract/channels.ts";
import { parseChannelKey } from "../contract/surface.ts";
import { MAX_TURN_IMAGES } from "../domain/attachment.ts";
import type { Logger } from "../log.ts";
import { contextImages, type SkippedImage } from "./context-images.ts";
import { embedText } from "./embed-text.ts";
import type { BotIdentity } from "./inbound-message.ts";

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
	foreignWebhook: () => false,
	authors: () => undefined,
	attachments: Object.freeze({ images: 0, maxBytes: 10 * 1024 * 1024 }),
});

/** The host's options, then the call's, over the defaults; the attachments' members merge one by one. */
function resolvedSettings(
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
function assertChannelContextSettings(settings: ChannelContextSettings): void {
	const { fetch, keep, similarity, messageChars, botMessageChars } = settings;
	const { images, maxBytes } = settings.attachments;
	const positive = { fetch, keep, messageChars, botMessageChars };
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
	if (!Number.isInteger(images) || images < 0 || images > MAX_TURN_IMAGES)
		throw new RangeError(
			`channel context option attachments.images must be an integer from 0 to ${MAX_TURN_IMAGES}, got ${images}`,
		);
	if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_IMAGE_BYTES)
		throw new RangeError(
			`channel context option attachments.maxBytes must be an integer from 1 to ${MAX_IMAGE_BYTES}, got ${maxBytes}`,
		);
}

/** What channel context reads of one fetched message. */
export type ContextSourceMessage = ChannelContextSource;

/** A file attached to a fetched message, as Discord describes it. */
export type ContextSourceAttachment = ChannelContextSourceAttachment;

/** The options that were given: a key set to undefined is the same as a missing one. */
function defined<T extends object>(options: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(options).filter(([, value]) => value !== undefined),
	) as Partial<T>;
}

function attachmentLabel(contentType: string | null | undefined): string {
	const type = contentType ?? "";
	if (type.startsWith("image/")) return "image";
	if (type.startsWith("video/")) return "video";
	if (type.startsWith("audio/")) return "audio";
	return "file";
}

/** The facts of a fetched Discord message channel context reads: mentions by name, stickers and files as text, never their bytes. */
export function contextSourceOf(
	message: Message,
	{ botId, applicationId }: BotIdentity,
): ContextSourceMessage {
	const { users, members } = message.mentions;
	const text = message.content.replace(/<@!?(\d+)>/g, (mention, id: string) => {
		const user = users.get(id);
		if (!user) return mention;
		return `@${members?.get(id)?.displayName ?? user.globalName ?? user.username}`;
	});
	const embeds = embedText(message.embeds);
	const parts = [text.trim(), embeds].filter(Boolean);
	for (const sticker of message.stickers.values())
		parts.push(`[sticker: ${sticker.name}]`);
	for (const file of message.attachments.values())
		parts.push(
			`[${attachmentLabel(file.contentType)}: ${file.name} ${file.url}]`,
		);
	const ownWebhook =
		message.webhookId !== null &&
		message.applicationId !== null &&
		message.applicationId === (applicationId ?? botId);
	return {
		id: message.id,
		authorId: message.author.id,
		authorName:
			message.member?.displayName ??
			message.author.globalName ??
			message.author.username,
		bot: message.author.bot,
		own: message.author.id === botId || ownWebhook,
		...(ownWebhook && message.webhookId
			? { webhookId: message.webhookId }
			: {}),
		at: message.createdTimestamp,
		text: parts.join(" "),
		attachments: [...message.attachments.values()].map((file) => ({
			name: file.name,
			contentType: file.contentType ?? "",
			size: file.size,
			url: file.url,
		})),
	};
}

/** Texts are compared by no more than their first characters: the comparison is quadratic, and the display cap is configurable. */
const SIMILARITY_CHARS = 500;

/** The length of the longest common substring over the longer text's length: 1 for equal texts. */
function similarity(a: string, b: string): number {
	if (a === b) return 1;
	const [shorter, longer] = (a.length <= b.length ? [a, b] : [b, a]).map(
		(text) => text.slice(0, SIMILARITY_CHARS),
	) as [string, string];
	if (shorter.length === 0) return 0;
	let longest = 0;
	let previous = new Uint16Array(shorter.length + 1);
	let current = new Uint16Array(shorter.length + 1);
	for (let i = 1; i <= longer.length; i++) {
		for (let j = 1; j <= shorter.length; j++) {
			current[j] =
				longer[i - 1] === shorter[j - 1] ? (previous[j - 1] ?? 0) + 1 : 0;
			longest = Math.max(longest, current[j] ?? 0);
		}
		[previous, current] = [current, previous];
		current.fill(0);
	}
	return longest / longer.length;
}

/**
 * Consecutive messages of one author at least `threshold` alike become the later one. A `foreign`
 * message is one of a webhook that carries many people, so it also needs the same name.
 */
function merged(
	messages: readonly ContextSourceMessage[],
	threshold: number,
	foreign: (message: ContextSourceMessage) => boolean,
): ContextSourceMessage[] {
	const out: ContextSourceMessage[] = [];
	for (const message of messages) {
		const last = out.at(-1);
		if (
			last &&
			last.authorId === message.authorId &&
			(!foreign(message) || last.authorName === message.authorName) &&
			similarity(last.text, message.text) >= threshold
		)
			out[out.length - 1] = message;
		else out.push(message);
	}
	return out;
}

function cut(text: string, chars: number): string {
	return text.length > chars ? `${text.slice(0, chars)}…` : text;
}

/** What `selectChannelContext` decides by. */
export interface ChannelContextSelection {
	/** Messages already delivered to the conversation. */
	seen: ReadonlySet<string>;
	/** The owners' user ids. */
	owners: readonly string[];
	/** What the selection reads of the settings; without `foreignWebhook` every webhook of the application is the assistant's. */
	settings: Omit<
		ChannelContextSettings,
		"foreignWebhook" | "authors" | "attachments"
	> &
		Partial<Pick<ChannelContextSettings, "foreignWebhook" | "authors">>;
}

/**
 * The window of fetched messages (all before the addressed one): those after the assistant's
 * latest post, without its own posts, those already delivered, and empty ones; near repeats merged,
 * the newest `keep`, oldest first. `window` is every message it considered, kept or not.
 */
export function selectChannelContext(
	fetched: readonly ContextSourceMessage[],
	{ seen, owners, settings }: ChannelContextSelection,
): { messages: ChannelContextMessage[]; window: string[] } {
	// `authors` says whose a message is; without an answer, a webhook of the application that the
	// host calls foreign (`foreignWebhook`) speaks for other people, one it calls "skip" speaks for
	// no one, and the rest is the assistant's when it posted it. A skipped post is not in the channel
	// as far as the window and the context go.
	const verdict = (message: ContextSourceMessage): ChannelContextVerdict => {
		const given = settings.authors?.(message);
		if (given === "keep" || given === "skip" || given === "end") return given;
		const hook =
			message.webhookId === undefined
				? undefined
				: settings.foreignWebhook?.(message.webhookId);
		if (hook === "skip") return "skip";
		if (hook === true) return "keep";
		return message.own ? "end" : "keep";
	};
	const verdicts = new Map(
		fetched.map((message) => [message.id, verdict(message)] as const),
	);
	const ordered = fetched
		.filter((message) => verdicts.get(message.id) !== "skip")
		.toSorted((a, b) => a.at - b.at);
	// A webhook that carries many people: its posts merge only under one name.
	const foreign = (message: ContextSourceMessage) =>
		message.webhookId !== undefined && verdicts.get(message.id) === "keep";
	const assistants = (message: ContextSourceMessage) =>
		verdicts.get(message.id) === "end";
	const lastOwn = ordered.findLastIndex(assistants);
	const window = ordered.slice(lastOwn + 1);
	// Cut before comparing: the comparison is quadratic in the text lengths.
	const fresh = window
		.filter(
			(message) =>
				!assistants(message) && !seen.has(message.id) && message.text !== "",
		)
		.map((message) => ({
			...message,
			text: cut(
				message.text,
				message.bot ? settings.botMessageChars : settings.messageChars,
			),
		}));
	const kept = merged(fresh, settings.similarity, foreign).slice(
		-settings.keep,
	);
	return {
		window: window.map((message) => message.id),
		messages: kept.map((message) => ({
			id: message.id,
			authorId: message.authorId,
			authorName: message.authorName,
			bot: message.bot,
			owner:
				!message.bot && !message.external && owners.includes(message.authorId),
			...(message.external ? { external: true } : {}),
			text: message.text,
			at: new Date(message.at),
			attachments: (message.attachments ?? []).map((file) => ({
				...file,
				messageId: message.id,
			})),
		})),
	};
}

/** The messages with a note in the text of each for an image that was asked for and not attached. */
function withSkipNotes(
	messages: readonly ChannelContextMessage[],
	skipped: readonly SkippedImage[],
): ChannelContextMessage[] {
	return messages.map((message) => {
		const notes = skipped
			.filter((image) => image.messageId === message.id)
			.map((image) => `[image not attached: ${image.name}: ${image.reason}]`);
		return notes.length === 0
			? { ...message }
			: { ...message, text: [message.text, ...notes].join(" ") };
	});
}

/** How many delivered message ids are remembered per channel, and how many channels. */
const SEEN_PER_CHANNEL = 500;
const SEEN_CHANNELS = 1_000;

export interface ChannelContextReaderOptions {
	/** A channel's messages before one, by their ids; undefined for a channel that is not a server text channel. */
	read(
		channelId: string,
		before: string,
		limit: number,
	): Promise<readonly ContextSourceMessage[] | undefined>;
	/** The owners' Discord user ids. */
	owners(): Promise<readonly string[]>;
	/** The host's settings; `false` turns channel context off for every claim. */
	settings: ChannelContextOptions | false;
	logger: Logger;
	/** Fetches the images of messages; replaceable in tests. */
	fetchImpl?: typeof fetch;
}

/**
 * Reads the channel context of addressed messages and remembers, per channel and in memory, what
 * it handed over and which messages addressed the assistant, so neither comes again.
 */
export class ChannelContextReader {
	readonly #options: ChannelContextReaderOptions;
	readonly #seen = new Map<string, Set<string>>();

	constructor(options: ChannelContextReaderOptions) {
		this.#options = options;
	}

	/**
	 * The context of a message in a server channel; undefined in a direct message, on another
	 * surface, when the host turned it off, when nothing new was said, and when Discord cannot be
	 * read, which is logged. Rejects only for an invalid option, a programming error of the caller.
	 */
	async of(
		message: InboundMessage,
		options: ChannelContextOptions = {},
	): Promise<ChannelContext | undefined> {
		const { settings: host, logger } = this.#options;
		if (host === false || message.isDirect || message.space === undefined)
			return undefined;
		const { surface, id: channelId } = parseChannelKey(message.channel);
		if (surface !== "discord") return undefined;
		const settings = resolvedSettings(host, options);
		assertChannelContextSettings(settings);
		const seen = this.#seenIn(channelId);
		seen.add(message.messageId);
		try {
			const fetched = await this.#options.read(
				channelId,
				message.messageId,
				Math.min(settings.fetch, 100),
			);
			if (!fetched) return undefined;
			const owners = await this.#owners();
			const { messages, window } = selectChannelContext(fetched, {
				seen,
				owners,
				settings,
			});
			for (const id of window) seen.add(id);
			this.#trim(seen);
			if (messages.length === 0) return undefined;
			const { images, skipped } = await this.#images(messages, settings);
			const noted = withSkipNotes(messages, skipped);
			return {
				messages: noted,
				text: formatChannelContext(noted),
				...(images.length > 0 ? { images } : {}),
			};
		} catch (error) {
			logger.warn(
				{ channel: message.channel, err: error },
				"channel context not read; the turn runs without it",
			);
			return undefined;
		}
	}

	/** The images of the kept messages the settings ask for, the newest first; none when they ask for none. */
	async #images(
		messages: readonly ChannelContextMessage[],
		settings: ChannelContextSettings,
	) {
		const { images: count, maxBytes } = settings.attachments;
		if (count === 0) return { images: [], skipped: [] };
		const candidates = messages
			.toReversed()
			.flatMap((message) => message.attachments ?? [])
			.filter((file) => file.contentType.startsWith("image/"));
		return contextImages(candidates, {
			count,
			maxBytes,
			logger: this.#options.logger,
			...(this.#options.fetchImpl
				? { fetchImpl: this.#options.fetchImpl }
				: {}),
		});
	}

	/** The owners' user ids; none, logged, when they cannot be read, since marking them is not worth failing for. */
	async #owners(): Promise<readonly string[]> {
		try {
			return await this.#options.owners();
		} catch (error) {
			this.#options.logger.warn(
				{ err: error },
				"could not read the owners; channel context marks none",
			);
			return [];
		}
	}

	#seenIn(channelId: string): Set<string> {
		let seen = this.#seen.get(channelId);
		if (!seen) {
			seen = new Set();
			this.#seen.set(channelId, seen);
			const oldest = this.#seen.keys().next().value;
			if (this.#seen.size > SEEN_CHANNELS && oldest !== undefined)
				this.#seen.delete(oldest);
		}
		return seen;
	}

	#trim(seen: Set<string>): void {
		for (const id of seen) {
			if (seen.size <= SEEN_PER_CHANNEL) return;
			seen.delete(id);
		}
	}
}

export { formatChannelContext };
