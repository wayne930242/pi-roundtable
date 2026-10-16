import {
	DISCORD_LIMITS,
	type DiscordCard,
	type DiscordMessage,
	type DiscordPoster,
	type PostedMessage,
	type RecentMessage,
} from "../discord/poster/poster.ts";
import {
	cardBody,
	checkAvatar,
	checkedPost,
	checkedText,
	checkSnowflake,
	checkWebhookName,
	invalid,
} from "../discord/poster/poster-checks.ts";
import { DiscordPosterError } from "../discord/poster/poster-errors.ts";
import {
	cardText,
	type FakePosterChannel,
	FakePosterGuild,
	type FakePosterMessage,
} from "./fake-poster-guild.ts";

export type {
	FakePosterChannel,
	FakePosterMessage,
} from "./fake-poster-guild.ts";
export { cardText } from "./fake-poster-guild.ts";

function blobOf(file: { data: Uint8Array; contentType?: string }) {
	return {
		data: file.data,
		...(file.contentType ? { contentType: file.contentType } : {}),
	};
}

/** What a test reads and sets on the fake poster, besides the `DiscordPoster` calls. */
export interface FakeDiscordPoster extends DiscordPoster {
	readonly channels: Map<string, FakePosterChannel>;
	readonly directs: { userId: string; content: string }[];
	/** People who take no direct message from the bot. */
	readonly closedDirects: Set<string>;
	/** Channels that do not exist (any more). */
	readonly goneChannels: Set<string>;
	/** The categories that exist; creating a channel under any other fails as `channel_gone`. */
	readonly categories: Set<string>;
	/** How many channels a category holds (Discord: 50) and a guild holds (Discord: 500). */
	categoryLimit: number;
	guildLimit: number;
	/** What the guild shows for a member, by user id; a user not listed has no name. */
	readonly memberNames: Map<string, string>;
	readonly memberLookups: { guildId: string; userId: string }[];
	/** The guild every channel is in unless `channelGuilds` says another. */
	guildId: string;
	readonly channelGuilds: Map<string, string>;
	/** `<channel id>:<user id>` pairs that cannot see the channel. */
	readonly hiddenFrom: Set<string>;
	/** People who are not members of the guild: they see no channel. */
	readonly nonMembers: Set<string>;
	/** Whether a pin posts the system notice Discord posts (type 6); off by default. */
	pinNotices: boolean;
	/** Whether the bot may read the audit log; off makes `threadCloser` fail as `forbidden`. */
	canReadAuditLog: boolean;
	/** Every rename, in order, as `[channel id, new name]`. */
	readonly renames: [string, string][];
	/** The bot user's id: the author of what `say` posts. */
	readonly botId: string;
	/** How many calls got past the argument checks, as the requests Discord would have seen. */
	readonly requests: number;
	/** Makes the next call of `operation` throw `error`. */
	failNext(operation: keyof DiscordPoster, error: DiscordPosterError): void;
	/** The channel's messages that still exist, oldest first. */
	messagesIn(channelId: string): FakePosterMessage[];
	/** A person writes in the channel (not through a webhook); the message's id. */
	speak(
		channelId: string,
		author: { id: string; name: string },
		content: string,
		files?: { name: string; data: Uint8Array; contentType?: string }[],
		urls?: string[],
	): string;
	/** A person archives (or locks) the thread; `auditSkew` moves the audit entry's time away from the archive's. */
	personCloses(
		threadId: string,
		userId: string,
		options?: { lock?: boolean; auditSkew?: number },
	): void;
	/** Discord archives a quiet thread on its own: no one is logged. */
	autoArchives(threadId: string): void;
	/** A person with Manage Threads opens a thread again. */
	personOpens(threadId: string): void;
	/** The threads started in a channel, oldest first. */
	threadsIn(
		channelId: string,
	): { id: string; name: string; startedOn: string }[];
	/** The named webhook was deleted by hand; the next post makes it again, with the default picture. */
	deleteWebhook(channelId: string, webhook: string): void;
	/** The named webhook was deleted by hand and is made again at once; `onWebhookMade` hears it. */
	recreateWebhook(channelId: string, webhook: string): Promise<void>;
}

/**
 * A `DiscordPoster` in memory for tests, made by `fakeDiscordPoster()`: channels with their messages, pins and webhook pictures,
 * and the direct messages sent. It keeps the real poster's argument checks (lengths, names,
 * mentions, avatar), so a consumer that breaks a limit fails here too, and it can be told to fail
 * the next call or to refuse direct messages from a person. The same scenarios run against it and
 * against the real poster over an emulated Discord, so the two answer alike.
 */
class FakePosterImpl extends FakePosterGuild implements FakeDiscordPoster {
	readonly #webhooks = new Map<string, string>();
	readonly #madeListeners = new Set<
		(channelId: string, webhook: string) => Promise<void>
	>();

	constructor(options: { idOffset?: bigint; now?: () => number } = {}) {
		super(options.idOffset ?? 0n, options.now ?? Date.now);
	}

	/** The channel's messages that still exist, oldest first. */
	messagesIn(channelId: string): FakePosterMessage[] {
		return [...(this.channels.get(channelId)?.messages ?? [])];
	}

	/** The id of the channel's webhook of that name, made on first use as Discord would (and announced). */
	async #webhook(channelId: string, name: string): Promise<string> {
		const slot = `${channelId}:${name}`;
		let id = this.#webhooks.get(slot);
		if (!id) {
			this.nextWebhook += 1n;
			id = this.nextWebhook.toString();
			this.#webhooks.set(slot, id);
			for (const listener of this.#madeListeners)
				await listener(channelId, name).catch(() => undefined);
		}
		return id;
	}

	/** Tests: the named webhook was deleted by hand. The next post makes it again, with the default picture. */
	deleteWebhook(channelId: string, webhook: string): void {
		this.#webhooks.delete(`${channelId}:${webhook}`);
		this.channels.get(channelId)?.avatars.delete(webhook);
	}

	/** Tests: the named webhook was deleted by hand and is made again at once; `onWebhookMade` hears it. */
	async recreateWebhook(channelId: string, webhook: string): Promise<void> {
		this.deleteWebhook(channelId, webhook);
		await this.#webhook(channelId, webhook);
	}

	async post(
		channelId: string,
		post: Parameters<DiscordPoster["post"]>[1],
	): Promise<PostedMessage> {
		checkSnowflake("a channel", channelId);
		const { webhook, body, files } = checkedPost(post);
		this.sent("post");
		const channel = this.channel(channelId);
		const webhookId = await this.#webhook(channelId, webhook);
		this.next += 1n;
		const message: FakePosterMessage = {
			id: this.next.toString(),
			username: body.username,
			content: body.content ?? "",
			files: files.map((file) => ({
				name: file.name,
				bytes: file.data.byteLength,
			})),
			blobs: files.map(blobOf),
			mentions: body.allowed_mentions.users,
			...("avatar_url" in body ? { avatarUrl: body.avatar_url } : {}),
			webhook,
			webhookId,
			at: this.tick(),
		};
		channel.messages.push(message);
		return { channelId, messageId: message.id };
	}

	/** A person writes in the channel (not through a webhook); the message's id. */
	speak(
		channelId: string,
		author: { id: string; name: string },
		content: string,
		files: { name: string; data: Uint8Array; contentType?: string }[] = [],
		urls?: string[],
	): string {
		const channel = this.channel(channelId);
		this.next += 1n;
		channel.messages.push({
			id: this.next.toString(),
			username: author.name,
			content,
			files: files.map((file) => ({
				name: file.name,
				bytes: file.data.byteLength,
			})),
			blobs: files.map(blobOf),
			mentions: [],
			authorId: author.id,
			...(urls ? { urls } : {}),
			at: this.tick(),
		});
		return this.next.toString();
	}

	/** Whether the message was posted by this webhook as it exists now. */
	#ownedBy(message: FakePosterMessage, channelId: string, name: string) {
		return (
			message.webhook === name &&
			message.webhookId === this.#webhooks.get(`${channelId}:${name}`)
		);
	}

	async edit(
		channelId: string,
		messageId: string,
		edit: { content: string; mentions?: readonly string[] },
		webhooks: readonly string[],
	): Promise<void> {
		checkSnowflake("a channel", channelId);
		checkSnowflake("a message", messageId);
		const body = checkedText(edit.content, edit.mentions);
		for (const name of webhooks) checkWebhookName(name);
		this.sent("edit");
		const message = this.found(channelId, messageId);
		if (!webhooks.some((name) => this.#ownedBy(message, channelId, name)))
			throw new DiscordPosterError(
				"message_gone",
				"the message does not exist",
			);
		message.content = body.content ?? "";
		message.mentions = body.allowed_mentions.users;
	}

	async remove(
		channelId: string,
		messageId: string,
		webhooks: readonly string[],
	): Promise<void> {
		checkSnowflake("a channel", channelId);
		checkSnowflake("a message", messageId);
		for (const name of webhooks) checkWebhookName(name);
		this.sent("remove");
		this.#drop(channelId, messageId);
	}

	#drop(channelId: string, messageId: string): void {
		const channel = this.channel(channelId);
		this.found(channelId, messageId);
		channel.messages = channel.messages.filter(
			(message) => message.id !== messageId,
		);
		channel.pins = channel.pins.filter((id) => id !== messageId);
	}

	async webhookIds(
		channelId: string,
		names: readonly string[],
	): Promise<Readonly<Record<string, readonly string[]>>> {
		checkSnowflake("a channel", channelId);
		for (const name of names) checkWebhookName(name);
		this.sent("webhookIds");
		const ids: Record<string, string[]> = {};
		for (const name of names) {
			const id = this.#webhooks.get(`${channelId}:${name}`);
			ids[name] = id ? [id] : [];
		}
		return ids;
	}

	async setAvatar(
		channelId: string,
		webhook: string,
		png: Uint8Array,
	): Promise<void> {
		checkSnowflake("a channel", channelId);
		checkWebhookName(webhook);
		checkAvatar(png);
		this.sent("setAvatar");
		const channel = this.channel(channelId);
		await this.#webhook(channelId, webhook);
		channel.avatars.set(webhook, png);
	}

	onWebhookMade(
		listener: (channelId: string, webhook: string) => Promise<void>,
	): () => void {
		this.#madeListeners.add(listener);
		return () => void this.#madeListeners.delete(listener);
	}

	async say(
		channelId: string,
		post: { content: string; mentions?: readonly string[] },
	): Promise<PostedMessage> {
		checkSnowflake("a channel", channelId);
		if (!post.content) throw invalid("a message needs text");
		const body = checkedText(post.content, post.mentions);
		this.sent("say");
		const channel = this.channel(channelId);
		this.wake(channel);
		this.next += 1n;
		channel.messages.push({
			id: this.next.toString(),
			username: "bot",
			content: body.content ?? "",
			files: [],
			blobs: [],
			mentions: body.allowed_mentions.users,
			authorId: this.botId,
			at: this.tick(),
		});
		return { channelId, messageId: this.next.toString() };
	}

	async sayCard(channelId: string, card: DiscordCard): Promise<PostedMessage> {
		checkSnowflake("a channel", channelId);
		cardBody(card);
		this.sent("sayCard");
		const channel = this.channel(channelId);
		this.wake(channel);
		this.next += 1n;
		channel.messages.push({
			id: this.next.toString(),
			username: "bot",
			content: cardText(card),
			files: [],
			blobs: [],
			mentions: [],
			authorId: this.botId,
			card,
			at: this.tick(),
		});
		return { channelId, messageId: this.next.toString() };
	}

	async editCard(
		channelId: string,
		messageId: string,
		card: DiscordCard,
	): Promise<void> {
		checkSnowflake("a channel", channelId);
		checkSnowflake("a message", messageId);
		cardBody(card);
		this.sent("editCard");
		const message = this.found(channelId, messageId);
		// A message posted without the Components V2 flag cannot become a card.
		if (!message.card)
			throw new DiscordPosterError(
				"rejected",
				"editing a card failed: that message is not a card",
				{ discordCode: 50035, status: 400 },
			);
		message.card = card;
		message.content = cardText(card);
	}

	async deleteAsBot(channelId: string, messageId: string): Promise<void> {
		checkSnowflake("a channel", channelId);
		checkSnowflake("a message", messageId);
		this.sent("deleteAsBot");
		this.#drop(channelId, messageId);
	}

	async sendDirect(
		userId: string,
		content: string,
	): Promise<"sent" | "closed"> {
		checkSnowflake("a user", userId);
		checkedText(content, []);
		this.sent("sendDirect");
		if (this.closedDirects.has(userId)) return "closed";
		this.directs.push({ userId, content });
		return "sent";
	}

	async pin(channelId: string, messageId: string): Promise<void> {
		checkSnowflake("a channel", channelId);
		checkSnowflake("a message", messageId);
		this.sent("pin");
		const channel = this.channel(channelId);
		this.found(channelId, messageId);
		if (channel.pins.includes(messageId)) return;
		if (channel.pins.length >= DISCORD_LIMITS.pins)
			throw new DiscordPosterError(
				"rejected",
				`a channel keeps at most ${DISCORD_LIMITS.pins} pins`,
				{ discordCode: 30003, status: 400 },
			);
		channel.pins.push(messageId);
		if (this.pinNotices) {
			this.next += 1n;
			channel.messages.push({
				id: this.next.toString(),
				username: "bot",
				content: "",
				files: [],
				blobs: [],
				mentions: [],
				authorId: this.botId,
				type: 6,
				referencedMessageId: messageId,
				at: this.tick(),
			});
		}
	}

	async unpin(channelId: string, messageId: string): Promise<void> {
		checkSnowflake("a channel", channelId);
		checkSnowflake("a message", messageId);
		this.sent("unpin");
		const channel = this.channel(channelId);
		channel.pins = channel.pins.filter((id) => id !== messageId);
	}

	async pinnedIds(channelId: string): Promise<string[]> {
		checkSnowflake("a channel", channelId);
		this.sent("pinnedIds");
		return [...this.channel(channelId).pins].reverse();
	}

	async message(channelId: string, messageId: string): Promise<DiscordMessage> {
		checkSnowflake("a channel", channelId);
		checkSnowflake("a message", messageId);
		this.sent("message");
		const found = this.found(channelId, messageId);
		return {
			id: found.id,
			authorId: found.webhookId ?? found.authorId ?? "0",
			...(found.webhookId ? { webhookId: found.webhookId } : {}),
			content: found.content,
			files: found.files.map((file, index) => ({
				name: file.name,
				contentType: found.blobs[index]?.contentType ?? "",
				size: file.bytes,
				url:
					found.urls?.[index] ??
					`https://cdn.test/${found.id}/${encodeURIComponent(file.name)}`,
			})),
		};
	}

	async recentMessages(
		channelId: string,
		limit: number,
	): Promise<RecentMessage[]> {
		checkSnowflake("a channel", channelId);
		this.sent("recentMessages");
		return [...this.channel(channelId).messages]
			.reverse()
			.slice(0, Math.min(50, Math.max(1, Math.trunc(limit))))
			.map((message) => ({
				id: message.id,
				type: message.type ?? 0,
				authorId: message.webhookId ?? message.authorId ?? "0",
				...(message.referencedMessageId
					? { referencedMessageId: message.referencedMessageId }
					: {}),
			}));
	}
}

/** A `DiscordPoster` in memory, to give a plugin under test as `DISCORD.poster`. */
export function fakeDiscordPoster(
	options: {
		/** Moves every id it makes, so test files that share a database never meet the same id. */
		idOffset?: bigint;
		/** The clock of the rename limit; default `Date.now`. */
		now?: () => number;
	} = {},
): FakeDiscordPoster {
	return new FakePosterImpl(options);
}
