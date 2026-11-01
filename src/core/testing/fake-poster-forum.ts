import type {
	ChannelKindInfo,
	ForumPost,
	ForumPostCreated,
	ForumTag,
	ForumTagInput,
} from "../discord/poster/poster.ts";
import { checkSnowflake } from "../discord/poster/poster-checks.ts";
import { DiscordPosterError } from "../discord/poster/poster-errors.ts";
import {
	checkedForumPost,
	checkedForumTags,
	checkedTagIds,
	notForum,
	readTag,
} from "../discord/poster/poster-forum.ts";
import { cardContent } from "./fake-poster-cards.ts";
import {
	type FakePosterChannel,
	FakePosterGuild,
} from "./fake-poster-guild.ts";

/** A forum the fake holds: the tags it offers. */
export interface FakeForum {
	tags: ForumTag[];
}

/** The fake's forum calls and `channelKind`, on top of its channel, thread and member calls. */
export abstract class FakePosterForum extends FakePosterGuild {
	/**
	 * The forums that exist, with their tags. A test makes one by setting an entry (and registering
	 * the channel in `channels`); a post made in a channel that is none fails as `not_forum`.
	 */
	readonly forums = new Map<string, FakeForum>();

	#forum(forumId: string): FakeForum {
		if (this.goneChannels.has(forumId))
			throw new DiscordPosterError(
				"channel_gone",
				"the channel does not exist",
			);
		const forum = this.forums.get(forumId);
		if (forum) return forum;
		if (this.channels.has(forumId) || this.categories.has(forumId))
			throw notForum("that channel");
		throw new DiscordPosterError("channel_gone", "the channel does not exist");
	}

	/** A tag the forum does not offer is Discord's 400. */
	#offered(forum: FakeForum, tagIds: readonly string[]): void {
		if (tagIds.some((id) => !forum.tags.some((tag) => tag.id === id)))
			throw new DiscordPosterError(
				"rejected",
				"a tag is not one the forum offers",
				{ discordCode: 50035, status: 400 },
			);
	}

	async channelKind(channelId: string): Promise<ChannelKindInfo> {
		checkSnowflake("a channel", channelId);
		this.sent("channelKind");
		if (this.goneChannels.has(channelId))
			throw new DiscordPosterError(
				"channel_gone",
				"the channel does not exist",
			);
		const guildId = this.channelGuilds.get(channelId) ?? this.guildId;
		if (this.categories.has(channelId)) return { guildId, kind: "category" };
		const channel = this.channels.get(channelId);
		if (!channel)
			throw new DiscordPosterError(
				"channel_gone",
				"the channel does not exist",
			);
		const parent = channel.parentId ? { parentId: channel.parentId } : {};
		if (this.forums.has(channelId))
			return { guildId, kind: "forum", ...parent };
		if (channel.startedOn !== undefined)
			return {
				guildId,
				kind:
					channel.parentId && this.forums.has(channel.parentId)
						? "forum_post"
						: "thread",
				...parent,
			};
		return { guildId, kind: "text", ...parent };
	}

	async forumTags(forumId: string): Promise<ForumTag[]> {
		checkSnowflake("a forum", forumId);
		this.sent("forumTags");
		return this.#forum(forumId).tags.map((tag) => ({ ...tag }));
	}

	async setForumTags(
		forumId: string,
		tags: readonly ForumTagInput[],
	): Promise<ForumTag[]> {
		checkSnowflake("a forum", forumId);
		const wire = checkedForumTags(tags);
		this.sent("setForumTags");
		const forum = this.#forum(forumId);
		const next = wire.map((tag) => {
			if ("id" in tag && !forum.tags.some((held) => held.id === tag.id))
				throw new DiscordPosterError("rejected", "a tag id is unknown", {
					discordCode: 50035,
					status: 400,
				});
			let id = "id" in tag ? tag.id : undefined;
			if (id === undefined) {
				this.nextChannel += 1n;
				id = this.nextChannel.toString();
			}
			return readTag({ ...tag, id }) as ForumTag;
		});
		forum.tags = next;
		return next.map((tag) => ({ ...tag }));
	}

	async createForumPost(
		forumId: string,
		post: ForumPost,
	): Promise<ForumPostCreated> {
		checkSnowflake("a forum", forumId);
		const checked = checkedForumPost(post);
		this.sent("createForumPost");
		const forum = this.#forum(forumId);
		this.#offered(forum, checked.appliedTags);
		this.nextChannel += 1n;
		const id = this.nextChannel.toString();
		const channel: FakePosterChannel = {
			name: post.name,
			parentId: forumId,
			topic: "",
			messages: [
				{
					id,
					username: "bot",
					content: post.card ? cardContent(post.card) : (post.content ?? ""),
					files: [],
					blobs: [],
					mentions: checked.mentions,
					authorId: this.botId,
					...(post.card ? { card: post.card } : {}),
					at: this.tick(),
				},
			],
			pins: [],
			avatars: new Map(),
			// The first message of a post has the post's own id.
			startedOn: id,
			autoArchiveMinutes: checked.autoArchive,
			appliedTags: checked.appliedTags,
		};
		this.channels.set(id, channel);
		return { threadId: id, messageId: id };
	}

	async setPostTags(
		threadId: string,
		tagIds: readonly string[],
	): Promise<void> {
		checkSnowflake("a thread", threadId);
		const ids = checkedTagIds(tagIds);
		this.sent("setPostTags");
		const channel = this.existing(threadId);
		const forum =
			channel.startedOn !== undefined && channel.parentId
				? this.forums.get(channel.parentId)
				: undefined;
		if (!forum) throw notForum("that thread's parent");
		this.#offered(forum, ids);
		channel.appliedTags = ids;
	}
}
