import type {
	CategoryChannel,
	DiscordCard,
	DiscordPoster,
	ThreadCloser,
	ThreadState,
} from "../discord/poster/poster.ts";
import {
	checkChannelName,
	checkSnowflake,
} from "../discord/poster/poster-checks.ts";
import { DiscordPosterError } from "../discord/poster/poster-errors.ts";

/** A message the fake holds: what Discord would show, and who it pinged. */
export interface FakePosterMessage {
	id: string;
	username: string;
	content: string;
	files: { name: string; bytes: number }[];
	/** The bytes of the files, in the same order. */
	blobs: { data: Uint8Array; contentType?: string }[];
	/** The users the message was allowed to ping. */
	mentions: string[];
	/** The picture the post asked to show beside its name; absent when it asked for none. */
	avatarUrl?: string;
	/** The name of the webhook that posted it, and its id; absent for a message a person or the bot wrote. */
	webhook?: string;
	webhookId?: string;
	/** Who wrote it, when a person or the bot did (`speak`, `say`); a webhook post is by its webhook. */
	authorId?: string;
	/** The files Discord lists on it, by name, when a test gives them addresses of their own (`speak`); else the fake's own. */
	urls?: string[];
	/** When it was posted, in the fake's own clock (one more for each message). */
	at: number;
	/** The card, for a message `sayCard` or `postCard` posted; `content` then holds its text. */
	card?: DiscordCard;
	/** Discord's message type; absent for an ordinary message, 6 for the notice a pin makes. */
	type?: number;
	/** For a pin notice: the message that was pinned. */
	referencedMessageId?: string;
}

export interface FakePosterChannel {
	/** The name and category of a channel the poster made; undefined for one that only received posts. */
	name: string | undefined;
	parentId: string | undefined;
	/** The topic of a channel the poster made. */
	topic: string;
	messages: FakePosterMessage[];
	pins: string[];
	/** The last picture set on each of the channel's webhooks, by webhook name. */
	avatars: Map<string, Uint8Array>;
	/** For a thread: the message of the parent channel it was started on. */
	startedOn?: string;
	/** For a thread: the minutes without a message after which it archives itself. */
	autoArchiveMinutes?: number;
	/** For a thread: whether it is archived. A post by the bot wakes it, as on Discord. */
	archived?: boolean;
	/** Every change of the archive state, in order (`true` is archived). */
	archiveLog?: boolean[];
	/** For a thread: whether it is locked (only a person with Manage Threads opens it again). */
	locked?: boolean;
	/** For a thread: when it was archived, in the fake's clock. */
	archivedAt?: number;
	/** For a thread: who closed it: the bot's id, a person's id, or none (Discord's own auto-archive). */
	closedBy?: string;
	/** For a thread: when the audit log says it was closed, in the fake's clock; the archive time when absent. */
	auditAt?: number;
}

/** How a channel may be renamed: twice in this many milliseconds. */
const RENAME_WINDOW_MS = 10 * 60_000;
const RENAMES_PER_WINDOW = 2;
/** How close an audit entry's time must be to the archive time to be that archive. */
const AUDIT_MATCH = 2 * 60_000;

/** A card as plain text, the way a test reads it. */
export function cardText(card: DiscordCard): string {
	return [
		`### ${card.title}`,
		...card.sections,
		...(card.footer ? [`-# ${card.footer}`] : []),
	].join("\n");
}

/** What `failNext` can fail: any call of the poster. */
export type PosterOperation = keyof DiscordPoster;

/** The fake's state, and the poster's channel, thread and member calls. */
export abstract class FakePosterGuild {
	readonly channels = new Map<string, FakePosterChannel>();
	readonly directs: { userId: string; content: string }[] = [];
	/** People who take no direct message from the bot. */
	readonly closedDirects = new Set<string>();
	/** Channels that do not exist (any more). */
	readonly goneChannels = new Set<string>();
	/** The bot user's id: the author of what `say` posts. */
	readonly botId: string = "990000000000000009";
	/** The categories that exist; creating a channel under any other fails as `channel_gone`. */
	readonly categories = new Set<string>();
	/** How many channels a category holds (Discord: 50) and a guild holds (Discord: 500). */
	categoryLimit = 50;
	guildLimit = 500;
	/** What the guild shows for a member, by user id; a user not listed has no name (`memberName` is undefined). */
	readonly memberNames = new Map<string, string>();
	/** Every `memberName` call, to see what was asked. */
	readonly memberLookups: { guildId: string; userId: string }[] = [];
	/** The guild every channel is in unless `channelGuilds` says another. */
	guildId = "700000000000000001";
	/** Channels (categories too) that are in another guild than `guildId`. */
	readonly channelGuilds = new Map<string, string>();
	/** `<channel id>:<user id>` pairs that cannot see the channel; everyone sees every channel otherwise. */
	readonly hiddenFrom = new Set<string>();
	/** People who are not members of the guild: they see no channel. */
	readonly nonMembers = new Set<string>();
	/** Whether a pin posts the system notice Discord posts (type 6); off by default so other tests keep their message counts. */
	pinNotices = false;
	/** Whether the bot may read the guild's audit log (View Audit Log); off makes `threadCloser` fail as `forbidden`. */
	canReadAuditLog = true;
	/** Every rename, in order, as `[channel id, new name]`. */
	readonly renames: [string, string][] = [];
	/** How many calls got past the argument checks, as the requests Discord would have seen. */
	requests = 0;

	protected next = 9_000_000_000_000_000_000n;
	protected nextWebhook = 6_000_000_000_000_000_000n;
	protected nextChannel = 8_000_000_000_000_000_000n;
	protected clock = 0;
	protected readonly now: () => number;
	protected readonly failures = new Map<
		PosterOperation,
		DiscordPosterError[]
	>();
	readonly #renameTimes = new Map<string, number[]>();
	readonly #guildsRead = new Set<string>();

	protected constructor(idOffset: bigint, now: () => number) {
		this.next += idOffset;
		this.nextWebhook += idOffset;
		this.nextChannel += idOffset;
		this.now = now;
	}

	/** Makes the next call of `operation` throw `error`. */
	failNext(operation: PosterOperation, error: DiscordPosterError): void {
		this.failures.set(operation, [
			...(this.failures.get(operation) ?? []),
			error,
		]);
	}

	/** Counts a call as a request, after its arguments passed; throws what `failNext` queued. */
	protected sent(operation: PosterOperation): void {
		this.requests += 1;
		const error = this.failures.get(operation)?.shift();
		if (error) throw error;
	}

	protected tick(): number {
		this.clock += 1;
		return this.clock;
	}

	protected channel(channelId: string): FakePosterChannel {
		if (this.goneChannels.has(channelId))
			throw new DiscordPosterError(
				"channel_gone",
				"the channel does not exist",
			);
		let channel = this.channels.get(channelId);
		if (!channel) {
			channel = {
				name: undefined,
				parentId: undefined,
				topic: "",
				messages: [],
				pins: [],
				avatars: new Map(),
			};
			this.channels.set(channelId, channel);
		}
		return channel;
	}

	protected found(channelId: string, messageId: string): FakePosterMessage {
		const message = this.channel(channelId).messages.find(
			(each) => each.id === messageId,
		);
		if (!message)
			throw new DiscordPosterError(
				"message_gone",
				"the message does not exist",
			);
		return message;
	}

	/** A channel or thread that exists; unlike a post's target, one nothing was ever posted to is gone. */
	protected existing(channelId: string): FakePosterChannel {
		const channel = this.channels.get(channelId);
		if (!channel || this.goneChannels.has(channelId))
			throw new DiscordPosterError(
				"channel_gone",
				"the channel does not exist",
			);
		return channel;
	}

	/** A post by the bot into an archived thread unarchives it, as Discord does. */
	protected wake(channel: FakePosterChannel): void {
		// A locked thread stays closed: the bot cannot post into it without Manage Threads.
		if (channel.archived && channel.locked)
			throw new DiscordPosterError("forbidden", "the thread is locked");
		if (channel.archived) {
			channel.archived = false;
			channel.archiveLog = [...(channel.archiveLog ?? []), false];
		}
	}

	async botUserId(): Promise<string> {
		return this.botId;
	}

	async channelGuild(channelId: string): Promise<string> {
		checkSnowflake("a channel", channelId);
		// The guild of a channel is kept after the first read, so the second asks Discord nothing.
		if (!this.#guildsRead.has(channelId)) {
			this.sent("channelGuild");
			if (this.goneChannels.has(channelId))
				throw new DiscordPosterError(
					"channel_gone",
					"the channel does not exist",
				);
			this.#guildsRead.add(channelId);
		}
		return this.channelGuilds.get(channelId) ?? this.guildId;
	}

	async canView(channelId: string, userId: string): Promise<boolean> {
		checkSnowflake("a channel", channelId);
		checkSnowflake("a user", userId);
		this.sent("canView");
		return (
			!this.nonMembers.has(userId) &&
			!this.hiddenFrom.has(`${channelId}:${userId}`)
		);
	}

	async memberName(
		guildId: string,
		userId: string,
	): Promise<string | undefined> {
		checkSnowflake("a guild", guildId);
		checkSnowflake("a user", userId);
		this.sent("memberName");
		this.memberLookups.push({ guildId, userId });
		return guildId === this.guildId ? this.memberNames.get(userId) : undefined;
	}

	async createTextChannel(
		categoryId: string,
		name: string,
		topic?: string,
	): Promise<string> {
		checkSnowflake("a category", categoryId);
		checkChannelName("a channel name", name);
		this.sent("createTextChannel");
		if (!this.categories.has(categoryId)) {
			if (this.channels.has(categoryId))
				throw new DiscordPosterError(
					"invalid",
					"that channel is not a category",
					{
						reason: "not_category",
					},
				);
			throw new DiscordPosterError(
				"channel_gone",
				"the category does not exist",
			);
		}
		const made = [...this.channels.values()].filter(
			(channel) => channel.name !== undefined,
		);
		if (made.length >= this.guildLimit)
			throw new DiscordPosterError(
				"rejected",
				"the guild holds the most channels Discord allows",
				{ discordCode: 30013, status: 400 },
			);
		if (
			made.filter((channel) => channel.parentId === categoryId).length >=
			this.categoryLimit
		)
			throw new DiscordPosterError(
				"rejected",
				`a category holds at most ${this.categoryLimit} channels`,
				{ discordCode: 50035, status: 400, reason: "category_full" },
			);
		this.nextChannel += 1n;
		const id = this.nextChannel.toString();
		this.channels.set(id, {
			name,
			parentId: categoryId,
			topic: topic ?? "",
			messages: [],
			pins: [],
			avatars: new Map(),
		});
		return id;
	}

	async textChannels(categoryId: string): Promise<CategoryChannel[]> {
		checkSnowflake("a category", categoryId);
		this.sent("textChannels");
		if (!this.categories.has(categoryId))
			throw new DiscordPosterError(
				"channel_gone",
				"the category does not exist",
			);
		return [...this.channels.entries()]
			.filter(
				([id, channel]) =>
					channel.parentId === categoryId &&
					channel.name !== undefined &&
					channel.startedOn === undefined &&
					!this.goneChannels.has(id),
			)
			.map(([id, channel]) => ({
				id,
				name: channel.name as string,
				topic: channel.topic,
			}));
	}

	async deleteChannel(channelId: string): Promise<void> {
		checkSnowflake("a channel", channelId);
		this.sent("deleteChannel");
		if (this.goneChannels.has(channelId) || !this.channels.has(channelId))
			throw new DiscordPosterError(
				"channel_gone",
				"the channel does not exist",
			);
		this.channels.delete(channelId);
		this.goneChannels.add(channelId);
	}

	async renameChannel(channelId: string, name: string): Promise<void> {
		checkSnowflake("a channel", channelId);
		checkChannelName("a channel name", name);
		this.sent("renameChannel");
		const channel = this.channel(channelId);
		// Discord lets a channel be renamed twice in ten minutes; the third is held back.
		const at = this.now();
		const recent = (this.#renameTimes.get(channelId) ?? []).filter(
			(time) => at - time < RENAME_WINDOW_MS,
		);
		if (recent.length >= RENAMES_PER_WINDOW)
			throw new DiscordPosterError(
				"unavailable",
				"renaming a channel failed (held back by Discord's rate limit)",
			);
		this.#renameTimes.set(channelId, [...recent, at]);
		channel.name = name;
		this.renames.push([channelId, name]);
	}

	async startThread(
		channelId: string,
		messageId: string,
		name: string,
	): Promise<string> {
		checkSnowflake("a channel", channelId);
		checkSnowflake("a message", messageId);
		checkChannelName("a thread name", name);
		this.sent("startThread");
		this.found(channelId, messageId);
		this.nextChannel += 1n;
		const id = this.nextChannel.toString();
		this.channels.set(id, {
			name,
			parentId: channelId,
			topic: "",
			messages: [],
			pins: [],
			avatars: new Map(),
			startedOn: messageId,
			autoArchiveMinutes: 10_080,
		});
		return id;
	}

	async setThreadArchived(threadId: string, archived: boolean): Promise<void> {
		checkSnowflake("a thread", threadId);
		this.sent("setThreadArchived");
		const channel = this.existing(threadId);
		// A locked thread is opened again only with Manage Threads, which the bot does not need for its own.
		if (!archived && channel.locked)
			throw new DiscordPosterError("forbidden", "the thread is locked");
		channel.archived = archived;
		channel.archiveLog = [...(channel.archiveLog ?? []), archived];
		if (archived) {
			channel.closedBy = this.botId;
			channel.archivedAt = this.tick();
			delete channel.auditAt;
		}
	}

	async threadState(threadId: string): Promise<ThreadState> {
		checkSnowflake("a thread", threadId);
		this.sent("threadState");
		const channel = this.existing(threadId);
		return {
			archived: channel.archived === true,
			locked: channel.locked === true,
			archivedAt: channel.archivedAt,
		};
	}

	async threadCloser(
		threadId: string,
		state: ThreadState,
	): Promise<ThreadCloser> {
		checkSnowflake("a thread", threadId);
		this.sent("threadCloser");
		if (!this.canReadAuditLog)
			throw new DiscordPosterError("forbidden", "missing View Audit Log");
		const channel = this.existing(threadId);
		if (!(state.archived || state.locked) || channel.closedBy === undefined)
			return { kind: "unknown" };
		// An archive's entry counts only when it is of the moment the thread was archived.
		if (
			!channel.locked &&
			channel.auditAt !== undefined &&
			channel.archivedAt !== undefined &&
			Math.abs(channel.auditAt - channel.archivedAt) > AUDIT_MATCH
		)
			return { kind: "unknown" };
		return channel.closedBy === this.botId
			? { kind: "bot" }
			: { kind: "person", userId: channel.closedBy };
	}

	/** A person archives (or locks) the given thread; `auditSkew` moves the audit entry's time away from the archive's. */
	personCloses(
		threadId: string,
		userId: string,
		options: { lock?: boolean; auditSkew?: number } = {},
	): void {
		const channel = this.channel(threadId);
		channel.archived = true;
		channel.archiveLog = [...(channel.archiveLog ?? []), true];
		channel.closedBy = userId;
		channel.archivedAt = this.tick();
		if (options.auditSkew !== undefined)
			channel.auditAt = channel.archivedAt + options.auditSkew;
		else delete channel.auditAt;
		if (options.lock) channel.locked = true;
	}

	/** Discord archives a quiet thread on its own: no one is logged. */
	autoArchives(threadId: string): void {
		const channel = this.channel(threadId);
		channel.archived = true;
		channel.archiveLog = [...(channel.archiveLog ?? []), true];
		delete channel.closedBy;
		channel.archivedAt = this.tick();
	}

	/** A person with Manage Threads opens a thread again. */
	personOpens(threadId: string): void {
		const channel = this.channel(threadId);
		channel.archived = false;
		channel.locked = false;
		channel.archiveLog = [...(channel.archiveLog ?? []), false];
	}

	/** The threads started in a channel, oldest first: their ids and the message each was started on. */
	threadsIn(
		channelId: string,
	): { id: string; name: string; startedOn: string }[] {
		return [...this.channels.entries()]
			.filter(
				([, channel]) => channel.parentId === channelId && channel.startedOn,
			)
			.map(([id, channel]) => ({
				id,
				name: channel.name ?? "",
				startedOn: channel.startedOn as string,
			}));
	}
}
