import {
	DISCORD_LIMITS,
	type ForumPost,
	type ForumTag,
	type ForumTagInput,
	type ThreadAutoArchive,
} from "./poster.ts";
import {
	cardBody,
	checkChannelName,
	checkedText,
	checkSnowflake,
} from "./poster-checks.ts";
import { DiscordPosterError, invalid } from "./poster-errors.ts";

/** Discord's channel type numbers the forum calls tell apart. */
export const CHANNEL_TYPE = Object.freeze({
	text: 0,
	category: 4,
	announcementThread: 10,
	publicThread: 11,
	privateThread: 12,
	forum: 15,
} as const);

/** The auto-archive durations Discord accepts, in minutes. */
const AUTO_ARCHIVE_MINUTES: readonly ThreadAutoArchive[] = [
	60, 1_440, 4_320, 10_080,
];

/** After how many minutes without a message a post archives itself when its maker says nothing: a week, as a thread. */
export const POST_ARCHIVE_MINUTES: ThreadAutoArchive = 10_080;

/** Whether the channel type is a thread's. */
export function isThreadType(type: unknown): boolean {
	return (
		type === CHANNEL_TYPE.announcementThread ||
		type === CHANNEL_TYPE.publicThread ||
		type === CHANNEL_TYPE.privateThread
	);
}

/** The error for a channel that is no forum (or a thread that is no forum post). */
export function notForum(what: string): DiscordPosterError {
	return new DiscordPosterError("invalid", `${what} is not a forum`, {
		reason: "not_forum",
	});
}

/** The tag ids of a post: at most five Discord ids, none twice. */
export function checkedTagIds(tagIds: readonly string[] | undefined): string[] {
	const ids = [...new Set(tagIds ?? [])];
	if (ids.length > DISCORD_LIMITS.postTags)
		throw invalid(`a post carries at most ${DISCORD_LIMITS.postTags} tags`);
	return ids.map((id) => checkSnowflake("a tag", id));
}

/** The checked tags of a forum, each as the wire form Discord's `available_tags` takes. */
export function checkedForumTags(tags: readonly ForumTagInput[]) {
	if (tags.length > DISCORD_LIMITS.forumTags)
		throw invalid(`a forum holds at most ${DISCORD_LIMITS.forumTags} tags`);
	const seen = new Set<string>();
	return tags.map((tag) => {
		const chars = [...tag.name].length;
		if (chars < 1 || chars > DISCORD_LIMITS.forumTagNameChars)
			throw invalid(
				`a tag name is 1 to ${DISCORD_LIMITS.forumTagNameChars} characters`,
			);
		if (tag.emoji !== undefined && tag.emojiId !== undefined)
			throw invalid("a tag has a Unicode emoji or a custom emoji, not both");
		if (tag.emoji === "") throw invalid("a tag's emoji is not empty");
		if (tag.id !== undefined) {
			checkSnowflake("a tag", tag.id);
			if (seen.has(tag.id)) throw invalid("a tag id is given once");
			seen.add(tag.id);
		}
		if (tag.emojiId !== undefined) checkSnowflake("a tag's emoji", tag.emojiId);
		return {
			...(tag.id === undefined ? {} : { id: tag.id }),
			name: tag.name,
			moderated: tag.moderated === true,
			emoji_id: tag.emojiId ?? null,
			emoji_name: tag.emoji ?? null,
		};
	});
}

/** A tag as Discord holds it, as `ForumTag`; undefined for an entry with no id or name. */
export function readTag(raw: unknown): ForumTag | undefined {
	if (raw === null || typeof raw !== "object") return undefined;
	const tag = raw as Record<string, unknown>;
	const id = typeof tag.id === "string" && tag.id !== "" ? tag.id : undefined;
	const name =
		typeof tag.name === "string" && tag.name !== "" ? tag.name : undefined;
	if (!(id && name)) return undefined;
	const emojiId =
		typeof tag.emoji_id === "string" && tag.emoji_id !== ""
			? tag.emoji_id
			: undefined;
	const emoji =
		typeof tag.emoji_name === "string" && tag.emoji_name !== ""
			? tag.emoji_name
			: undefined;
	return {
		id,
		name,
		moderated: tag.moderated === true,
		...(emojiId ? { emojiId } : emoji ? { emoji } : {}),
	};
}

/** The checked parts of a forum post: its name, tags, archive time and first message body. */
export function checkedForumPost(post: ForumPost) {
	checkChannelName("a post name", post.name);
	if ((post.card === undefined) === (post.content === undefined))
		throw invalid("a post has a card or text as its first message, not both");
	const autoArchive = post.autoArchive ?? POST_ARCHIVE_MINUTES;
	if (!AUTO_ARCHIVE_MINUTES.includes(autoArchive))
		throw invalid(
			`a post archives after ${AUTO_ARCHIVE_MINUTES.join(", ")} minutes`,
		);
	let message: ReturnType<typeof cardBody> | ReturnType<typeof checkedText>;
	let mentions: string[] = [];
	if (post.card) message = cardBody(post.card);
	else {
		if (!post.content) throw invalid("a post needs text");
		const text = checkedText(post.content, post.mentions);
		message = text;
		mentions = text.allowed_mentions.users;
	}
	return {
		name: post.name,
		autoArchive,
		appliedTags: checkedTagIds(post.appliedTags),
		/** The first message as Discord takes it. */
		message,
		/** The users the first message may ping. */
		mentions,
	};
}
