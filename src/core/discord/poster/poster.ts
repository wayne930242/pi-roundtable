/**
 * Discord's REST API for a plugin's own posts: webhook posts under names the plugin chooses, the
 * bot's own messages and cards, pins, direct messages, threads and channels. A host's Discord
 * plugin provides one as `DISCORD.poster`, over the gateway client's own REST queue; `fakeDiscordPoster`
 * (from `pi-roundtable/testing`) stands in for it in tests, and no test reaches Discord.
 */

export type {
	DiscordFailure,
	DiscordReason,
} from "./poster-errors.ts";
export { DiscordPosterError } from "./poster-errors.ts";

/** A file sent with a post. */
export interface PosterFile {
	name: string;
	data: Uint8Array;
	contentType?: string;
}

/** One message a channel's webhook posts. */
export interface WebhookPost {
	/**
	 * The name of the bot's webhook that posts it, found among the webhooks this bot made in the
	 * channel or made on first use: 1 to 80 characters, without "discord" or "clyde" in any case
	 * (Discord refuses those; refused here as `invalid` before anything is sent). A plugin keeps one
	 * name per voice it needs, so a message's `webhookId` tells its voices apart.
	 */
	webhook: string;
	/** The name shown for this message: 1 to 80 characters, not "everyone" or "here", without "discord" or "clyde" (`invalid`). */
	username: string;
	/** An `https` address of at most 2,048 characters for the picture beside the name; anything else is left out. */
	avatarUrl?: string;
	/** Up to 2,000 characters; a post needs this or a file. */
	content?: string;
	/** Up to 10 files, 10 MiB in all. */
	files?: readonly PosterFile[];
	/** The only users this message may ping (at most 20); `@everyone`, roles and users merely named never are. */
	mentions?: readonly string[];
}

/** A message the poster posted, to edit, delete or pin later. */
export interface PostedMessage {
	channelId: string;
	messageId: string;
}

/** One message as Discord holds it: enough to tell who posted it and to read its text and files. */
export interface DiscordMessage {
	id: string;
	/** The user who wrote it; for a webhook's post, the webhook's own pseudo-user. */
	authorId: string;
	/** The webhook that posted it; absent for a message a person or the bot wrote. */
	webhookId?: string;
	content: string;
	files: readonly {
		name: string;
		/** Empty when Discord does not say. */
		contentType: string;
		/** Bytes, as Discord reports. */
		size: number;
		url: string;
	}[];
}

/** A message of a channel as the recent listing shows it. */
export interface RecentMessage {
	id: string;
	/** Discord's message type: 0 is an ordinary message, 6 the notice a pin makes (by the bot when the bot pinned). */
	type: number;
	authorId: string;
	/** For a pin notice: the message that was pinned. */
	referencedMessageId?: string;
}

/**
 * A card the bot posts: a Components V2 container with a heading, text sections, a quiet last line
 * and an optional colour bar. Plain data, so a fake can hold and compare it. It carries no
 * `content` and no embeds and never pings.
 */
export interface DiscordCard {
	/** The colour of the bar along the side, as 0xRRGGBB. */
	accent?: number;
	title: string;
	sections: readonly string[];
	footer?: string;
	/** Up to five buttons in one row under the text; a press comes to the Discord plugin's interactions by `customId`. */
	buttons?: readonly CardButton[];
	/** Buttons that open an address, in the same row after `buttons` (five in all); a press reaches no interaction. */
	links?: readonly CardLink[];
	/** Drop-down menus, each in a row of its own above the buttons; a choice comes to the Discord plugin's interactions by `customId`. */
	selects?: readonly CardSelect[];
}

/** A button on a card. */
export interface CardButton {
	/** At most 100 characters; the interaction handler recognises its own by the prefix. */
	customId: string;
	/** At most 80 characters. */
	label: string;
	style: "primary" | "secondary" | "success" | "danger";
	disabled?: boolean;
}

/** A button that opens an address and sends nothing back to the bot. */
export interface CardLink {
	/** At most 80 characters. */
	label: string;
	/** An https address of at most 512 characters. */
	url: string;
}

/** A drop-down menu on a card. */
export interface CardSelect {
	/** At most 100 characters. */
	customId: string;
	/** At most 150 characters. */
	placeholder: string;
	/** One to 25 choices (labels and values of at most 100 characters); at most one marked `selected`. */
	options: readonly { label: string; value: string; selected?: boolean }[];
}

/** Whether a thread is closed, as Discord's thread metadata says. */
export interface ThreadState {
	archived: boolean;
	/** Locked: only people with Manage Threads can open it again; auto-archiving never locks. */
	locked: boolean;
	/** The thread's `archive_timestamp`, in milliseconds; undefined when Discord does not say. */
	archivedAt: number | undefined;
}

/** Who closed a thread. */
export type ThreadCloser =
	| { kind: "person"; userId: string }
	| { kind: "bot" }
	| { kind: "unknown" };

/** A text channel under a category. */
export interface CategoryChannel {
	id: string;
	name: string;
	/** The channel's topic; empty when it has none. */
	topic: string;
}

/** Discord's limits as the poster keeps them. */
export const DISCORD_LIMITS = Object.freeze({
	contentChars: 2_000,
	usernameChars: Object.freeze({ min: 1, max: 80 }),
	filesPerPost: 10,
	/** The most bytes the poster sends in one post, files together. */
	postBytes: 10 * 1024 * 1024,
	avatarBytes: 1024 * 1024,
	mentions: 20,
	/** Discord keeps at most this many pins in a channel; the poster leaves it to Discord, the fake enforces it. */
	pins: 250,
	/** The longest name Discord gives a channel (a thread too). */
	channelNameChars: 100,
	/** Discord counts at most 4,000 characters of text across a Components V2 message; a card keeps a margin. */
	cardTextChars: 3_800,
	/** The most buttons (links too) a card's row holds. */
	cardButtons: 5,
	selectOptions: 25,
} as const);

export interface DiscordPoster {
	// Webhook posts

	/** Posts through the channel's webhook of that name, found or made on first use. */
	post(channelId: string, post: WebhookPost): Promise<PostedMessage>;
	/**
	 * Replaces a webhook post's text, asking each named webhook in order (a webhook edits only its
	 * own messages); makes none. `message_gone` when none of them posted it.
	 */
	edit(
		channelId: string,
		messageId: string,
		edit: { content: string; mentions?: readonly string[] },
		webhooks: readonly string[],
	): Promise<void>;
	/**
	 * Deletes a message one of the named webhooks posted, else as the bot (Manage Messages, for one
	 * an earlier webhook of the same name posted); makes none. `message_gone` when it does not exist.
	 */
	remove(
		channelId: string,
		messageId: string,
		webhooks: readonly string[],
	): Promise<void>;
	/**
	 * The ids of the bot's webhooks in the channel under each name, found without making any; more
	 * than one of a name only when an earlier one was left behind.
	 */
	webhookIds(
		channelId: string,
		names: readonly string[],
	): Promise<Readonly<Record<string, readonly string[]>>>;
	/** Sets the named webhook's own picture from PNG bytes (at most 1 MiB; `invalid` otherwise). */
	setAvatar(channelId: string, webhook: string, png: Uint8Array): Promise<void>;
	/**
	 * Told, and awaited, when the poster makes a webhook (the first, or one made again after it was
	 * deleted: it carries the default picture). Only the call that made the webhook waits for the listeners; concurrent calls may use the new webhook before they finish. A listener that fails never fails the call. Returns
	 * the function that detaches it.
	 */
	onWebhookMade(
		listener: (channelId: string, webhook: string) => Promise<void>,
	): () => void;

	// The bot's own messages

	/** Posts as the bot itself, into a text channel or a thread, pinging only the users named. */
	say(
		channelId: string,
		post: { content: string; mentions?: readonly string[] },
	): Promise<PostedMessage>;
	/** Posts a card as the bot, into a text channel or a thread; it pings nobody. */
	sayCard(channelId: string, card: DiscordCard): Promise<PostedMessage>;
	/**
	 * Replaces a card the bot posted, keeping it a Components V2 message. A message posted without
	 * the flag cannot become a card: `rejected` (delete it and post a new card).
	 */
	editCard(
		channelId: string,
		messageId: string,
		card: DiscordCard,
	): Promise<void>;
	/** Deletes a message the bot posted, or the notice its own pin made. `message_gone` when it does not exist. */
	deleteAsBot(channelId: string, messageId: string): Promise<void>;
	/** A direct message with no pings, at most 2,000 characters; `closed` when the person takes none from the bot. */
	sendDirect(userId: string, content: string): Promise<"sent" | "closed">;

	// Pins

	pin(channelId: string, messageId: string): Promise<void>;
	unpin(channelId: string, messageId: string): Promise<void>;
	/** Newest pin first, all of a channel's (up to 250, read in pages of 50). */
	pinnedIds(channelId: string): Promise<string[]>;

	// Reading

	/** Reads one message; `message_gone` when it does not exist. */
	message(channelId: string, messageId: string): Promise<DiscordMessage>;
	/** The newest messages of a channel or thread, newest first (at most `limit`, 1 to 50). */
	recentMessages(channelId: string, limit: number): Promise<RecentMessage[]>;
	/** The bot's own user id: the author of what it posts into a channel. */
	botUserId(): Promise<string>;
	/** The guild a channel or category is in; kept, since it never changes. */
	channelGuild(channelId: string): Promise<string>;
	/**
	 * Whether a member sees the channel (View Channel, from their roles, the channel's overwrites
	 * and the guild owner and administrator rules); false for someone who is not a member.
	 */
	canView(channelId: string, userId: string): Promise<boolean>;
	/** The server nickname, else the global display name, else the username; `undefined` for a non-member. */
	memberName(guildId: string, userId: string): Promise<string | undefined>;

	// Channels

	/**
	 * A text channel under a category, with a topic when one is given, and no overwrites of its own,
	 * so it takes the category's. `channel_gone`, `forbidden` (Manage Channels), `rejected` with
	 * `reason: "category_full"`, `invalid` with `not_category` or `wrong_guild`.
	 */
	createTextChannel(
		categoryId: string,
		name: string,
		topic?: string,
	): Promise<string>;
	/** The text channels under a category, to pick a name that is not taken and to find one made earlier. */
	textChannels(categoryId: string): Promise<CategoryChannel[]>;
	/** Deletes a channel; one that is already gone is `channel_gone`. */
	deleteChannel(channelId: string): Promise<void>;
	/**
	 * Renames a channel (Manage Channels). Discord lets a channel be renamed twice in ten minutes; a
	 * rename past that is not queued: it fails as `unavailable` after a short wait and is never sent
	 * later.
	 */
	renameChannel(channelId: string, name: string): Promise<void>;

	// Threads

	/**
	 * A public thread on a message of a text channel, archiving itself after a week without a message
	 * and waking on the next (Create Public Threads). Returns the thread's id (a thread is a channel).
	 */
	startThread(
		channelId: string,
		messageId: string,
		name: string,
	): Promise<string>;
	/** A thread the bot started needs no Manage Threads either way; a locked thread needs it to open again. `channel_gone` when it does not exist. */
	setThreadArchived(threadId: string, archived: boolean): Promise<void>;
	/** Whether a thread is archived or locked now, and when it was archived. `channel_gone` when it does not exist. */
	threadState(threadId: string): Promise<ThreadState>;
	/**
	 * Who archived or locked a thread, from the guild's audit log (View Audit Log, else `forbidden`),
	 * for the archive or lock `state` describes; `unknown` for Discord's own auto-archive, and when
	 * the entry is not among the log's newest 50.
	 */
	threadCloser(threadId: string, state: ThreadState): Promise<ThreadCloser>;
}
