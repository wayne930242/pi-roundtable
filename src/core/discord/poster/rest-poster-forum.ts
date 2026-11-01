import { Routes } from "discord.js";
import type { ChannelKind, DiscordPoster } from "./poster.ts";
import { checkSnowflake } from "./poster-checks.ts";
import { DiscordPosterError, failure } from "./poster-errors.ts";
import {
	CHANNEL_TYPE,
	checkedForumPost,
	checkedForumTags,
	checkedTagIds,
	isThreadType,
	notForum,
	readTag,
} from "./poster-forum.ts";
import { object, type RestCore, text } from "./rest-poster-core.ts";

/** The poster's calls that tell what a channel is, and the forum calls. */
export type ForumOperations = Pick<
	DiscordPoster,
	| "channelKind"
	| "forumTags"
	| "setForumTags"
	| "createForumPost"
	| "setPostTags"
>;

export function forumOperations(core: RestCore): ForumOperations {
	const { rest } = core;

	/** What a channel is, from its type and, for a thread, its parent's. */
	const kindOf = async (channelId: string) => {
		// A thread's parent never changes; a channel's category does, so it is read afresh.
		const read = await core.readChannel(channelId, { withParent: true });
		let kind: ChannelKind;
		if (read.type === CHANNEL_TYPE.text) kind = "text";
		else if (read.type === CHANNEL_TYPE.category) kind = "category";
		else if (read.type === CHANNEL_TYPE.forum) kind = "forum";
		else if (isThreadType(read.type)) {
			const parent = read.parentId
				? await core.readChannel(read.parentId)
				: undefined;
			kind = parent?.type === CHANNEL_TYPE.forum ? "forum_post" : "thread";
		} else kind = "other";
		return {
			guildId: read.guildId,
			kind,
			...(read.parentId ? { parentId: read.parentId } : {}),
		};
	};

	const requireForum = async (forumId: string) => {
		if ((await core.readChannel(forumId)).type !== CHANNEL_TYPE.forum)
			throw notForum("that channel");
	};

	return {
		async channelKind(channelId) {
			checkSnowflake("a channel", channelId);
			return kindOf(channelId);
		},
		async forumTags(forumId) {
			checkSnowflake("a forum", forumId);
			const forum = object(
				await rest.get(Routes.channel(forumId)).catch((error: unknown) => {
					throw failure("reading a forum", error);
				}),
			);
			if (forum.type !== CHANNEL_TYPE.forum) throw notForum("that channel");
			return (Array.isArray(forum.available_tags) ? forum.available_tags : [])
				.map(readTag)
				.filter((tag) => tag !== undefined);
		},
		async setForumTags(forumId, tags) {
			checkSnowflake("a forum", forumId);
			const wire = checkedForumTags(tags);
			await requireForum(forumId);
			const changed = object(
				await rest
					.patch(Routes.channel(forumId), { body: { available_tags: wire } })
					.catch((error: unknown) => {
						throw failure("setting a forum's tags", error);
					}),
			);
			return (
				Array.isArray(changed.available_tags) ? changed.available_tags : []
			)
				.map(readTag)
				.filter((tag) => tag !== undefined);
		},
		async createForumPost(forumId, post) {
			checkSnowflake("a forum", forumId);
			const checked = checkedForumPost(post);
			await requireForum(forumId);
			const made = object(
				await rest
					.post(Routes.threads(forumId), {
						body: {
							name: checked.name,
							auto_archive_duration: checked.autoArchive,
							...(checked.appliedTags.length > 0
								? { applied_tags: checked.appliedTags }
								: {}),
							message: checked.message,
						},
					})
					.catch((error: unknown) => {
						throw failure("making a forum post", error);
					}),
			);
			const threadId = text(made.id);
			if (!threadId)
				throw new DiscordPosterError("rejected", "Discord made no post");
			// The first message of a post has the post's own id.
			return {
				threadId,
				messageId: text(object(made.message).id) ?? threadId,
			};
		},
		async setPostTags(threadId, tagIds) {
			checkSnowflake("a thread", threadId);
			const applied = checkedTagIds(tagIds);
			if ((await kindOf(threadId)).kind !== "forum_post")
				throw notForum("that thread's parent");
			// An archived post is refused (50083) unless the same PATCH opens it again.
			await rest
				.patch(Routes.channel(threadId), {
					body: { applied_tags: applied, archived: false },
				})
				.catch((error: unknown) => {
					throw failure("setting a post's tags", error);
				});
		},
	};
}
