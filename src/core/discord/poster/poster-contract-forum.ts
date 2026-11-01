import { expect } from "bun:test";
import type { DiscordCard, ForumPost } from "./poster.ts";
import {
	expectFailure,
	freshId,
	type Scenario,
} from "./poster-contract-support.ts";

const CARD: DiscordCard = {
	accent: 0x336699,
	title: "Ticket",
	sections: ["first", "second"],
	footer: "quiet",
	buttons: [{ customId: "go:1", label: "Go", style: "primary" }],
	links: [{ label: "Open", url: "https://example.test/t/1" }],
};

const PREVIEW: DiscordCard = {
	...CARD,
	preview: "Ticket 1 needs a look",
	thumbnail: { url: "https://img.example.test/t.png", description: "t" },
	image: { url: "https://img.example.test/p.png" },
	selects: [
		{
			customId: "pick:1",
			placeholder: "State",
			options: [
				{ label: "Open", value: "open", selected: true },
				{ label: "Done", value: "done" },
			],
		},
	],
};

/** A forum with two tags the scenario made through the poster. */
async function taggedForum(
	poster: import("./poster.ts").DiscordPoster,
	world: { forum(id: string): void },
) {
	const forum = freshId();
	world.forum(forum);
	const [bug, idea] = await poster.setForumTags(forum, [
		{ name: "bug" },
		{ name: "idea", moderated: true, emoji: "💡" },
	]);
	if (!(bug && idea)) throw new Error("the forum made no tags");
	return { forum, bug, idea };
}

/** The scenarios of forums, forum posts, channel kinds and preview cards. */
export const forumScenarios: Scenario[] = [
	{
		name: "16. channelKind: text channel, category, forum, thread and forum post are told apart, with their parent; a missing channel is gone",
		async run({ poster, world }) {
			const text = freshId();
			const category = freshId();
			const forum = freshId();
			world.channel(text);
			world.category(category);
			world.forum(forum);
			expect(await poster.channelKind(text)).toEqual({
				guildId: world.guildId,
				kind: "text",
			});
			expect(await poster.channelKind(category)).toEqual({
				guildId: world.guildId,
				kind: "category",
			});
			expect(await poster.channelKind(forum)).toEqual({
				guildId: world.guildId,
				kind: "forum",
			});
			const root = await poster.say(text, { content: "root" });
			const thread = await poster.startThread(text, root.messageId, "talk");
			expect(await poster.channelKind(thread)).toEqual({
				guildId: world.guildId,
				kind: "thread",
				parentId: text,
			});
			const post = await poster.createForumPost(forum, {
				name: "ticket",
				content: "first",
			});
			expect(await poster.channelKind(post.threadId)).toEqual({
				guildId: world.guildId,
				kind: "forum_post",
				parentId: forum,
			});
			await expectFailure(
				poster.channelKind("900000000000099999"),
				"channel_gone",
			);
			await expectFailure(poster.channelKind("nope"), "invalid");
		},
	},
	{
		name: "17. forum tags: made, kept by id when the set is sent again, renamed and dropped; what a forum cannot hold is refused",
		async run({ poster, world }) {
			const forum = freshId();
			world.forum(forum);
			expect(await poster.forumTags(forum)).toEqual([]);
			const made = await poster.setForumTags(forum, [
				{ name: "bug" },
				{ name: "idea", moderated: true, emoji: "💡" },
			]);
			expect(made.map((tag) => tag.name)).toEqual(["bug", "idea"]);
			expect(made[0]?.id).not.toBe(made[1]?.id);
			expect(made[0]?.moderated).toBe(false);
			expect(made[1]).toMatchObject({ moderated: true, emoji: "💡" });
			expect(await poster.forumTags(forum)).toEqual(made);
			const [bug, idea] = made;
			if (!(bug && idea)) throw new Error("no tags");
			// A tag sent again with its id is kept (and may be renamed); one with none is made.
			const next = await poster.setForumTags(forum, [
				{ ...bug, name: "defect" },
				idea,
				{ name: "docs" },
			]);
			expect(next.map((tag) => tag.name)).toEqual(["defect", "idea", "docs"]);
			expect(next[0]?.id).toBe(bug.id);
			expect(next[1]?.id).toBe(idea.id);
			// A tag left out is deleted.
			const [defect, , docs] = next;
			if (!(defect && docs)) throw new Error("no tags");
			expect(
				(await poster.setForumTags(forum, [defect, docs])).map((t) => t.id),
			).toEqual([defect.id, docs.id]);
			// What Discord would refuse is refused before any request.
			const before = world.requests();
			await expectFailure(
				poster.setForumTags(forum, [{ name: "" }]),
				"invalid",
			);
			await expectFailure(
				poster.setForumTags(forum, [{ name: "x".repeat(21) }]),
				"invalid",
			);
			await expectFailure(
				poster.setForumTags(
					forum,
					Array.from({ length: 21 }, (_, i) => ({ name: `t${i}` })),
				),
				"invalid",
			);
			await expectFailure(
				poster.setForumTags(forum, [defect, { ...defect }]),
				"invalid",
			);
			await expectFailure(
				poster.setForumTags(forum, [
					{ name: "both", emoji: "💡", emojiId: "900000000000000123" },
				]),
				"invalid",
			);
			await expectFailure(
				poster.setForumTags(forum, [{ id: "nope", name: "x" }]),
				"invalid",
			);
			expect(world.requests()).toBe(before);
			// A tag id the forum never had is Discord's refusal.
			await expectFailure(
				poster.setForumTags(forum, [{ id: "900000000000099999", name: "x" }]),
				"rejected",
			);
			expect((await poster.forumTags(forum)).map((tag) => tag.id)).toEqual([
				defect.id,
				docs.id,
			]);
			// A channel that is no forum, and one that is gone.
			const text = freshId();
			world.channel(text);
			await expectFailure(poster.forumTags(text), "invalid", {
				reason: "not_forum",
			});
			await expectFailure(poster.setForumTags(text, []), "invalid", {
				reason: "not_forum",
			});
			await expectFailure(
				poster.forumTags("900000000000099999"),
				"channel_gone",
			);
		},
	},
	{
		name: "18. a forum post: made with a card or text as its first message, editable and renamable like a thread; the first message has the thread's id",
		async run({ poster, world }) {
			const { forum, bug, idea } = await taggedForum(poster, world);
			const card = await poster.createForumPost(forum, {
				name: "ticket 1",
				card: CARD,
				appliedTags: [bug.id, idea.id],
			});
			expect(card.messageId).toBe(card.threadId);
			expect(world.isCard(card.threadId, card.messageId)).toBe(true);
			expect(world.appliedTags(card.threadId)).toEqual([bug.id, idea.id]);
			expect(world.autoArchiveMinutes(card.threadId)).toBe(10_080);
			// The card is edited as any card is, by the thread and message ids.
			await poster.editCard(card.threadId, card.messageId, {
				...CARD,
				title: "Ticket 2",
				buttons: [],
			});
			expect(world.isCard(card.threadId, card.messageId)).toBe(true);
			await poster.sayCard(card.threadId, CARD);
			await poster.say(card.threadId, { content: "a reply in the post" });
			await poster.pin(card.threadId, card.messageId);
			expect(await poster.pinnedIds(card.threadId)).toEqual([card.messageId]);
			// A post is renamed as a channel is, twice in ten minutes.
			await poster.renameChannel(card.threadId, "ticket 1 (done)");
			await poster.renameChannel(card.threadId, "ticket 1 (closed)");
			await expectFailure(
				poster.renameChannel(card.threadId, "ticket 1 (again)"),
				"unavailable",
			);
			// A post of plain text, with its own archive time and the one user it may ping.
			const user = freshId();
			const text = await poster.createForumPost(forum, {
				name: "notes",
				content: "hello <@everyone>",
				mentions: [user],
				autoArchive: 1_440,
			});
			expect(text.messageId).toBe(text.threadId);
			expect(world.autoArchiveMinutes(text.threadId)).toBe(1_440);
			expect(world.isCard(text.threadId, text.messageId)).toBe(false);
			expect(world.mentionsOf(text.threadId, text.messageId)).toEqual({
				parse: [],
				users: [user],
			});
			expect(
				(await poster.message(text.threadId, text.messageId)).content,
			).toBe("hello <@everyone>");
			await expectFailure(
				poster.editCard(text.threadId, text.messageId, CARD),
				"rejected",
			);
			// The post holds its first message only: nothing else was posted in it.
			expect(await poster.recentMessages(text.threadId, 10)).toHaveLength(1);
		},
	},
	{
		name: "19. createForumPost: what Discord would refuse is refused first; a channel that is no forum is told so",
		async run({ poster, world }) {
			const { forum, bug } = await taggedForum(poster, world);
			const refused = (post: unknown) =>
				expectFailure(
					poster.createForumPost(forum, post as ForumPost),
					"invalid",
				);
			const before = world.requests();
			await refused({ name: "x" });
			await refused({ name: "x", card: CARD, content: "both" });
			await refused({ name: "", content: "x" });
			await refused({ name: "x".repeat(101), content: "x" });
			await refused({ name: "x", content: "" });
			await refused({ name: "x", content: "a".repeat(2_001) });
			await refused({
				name: "x",
				card: { ...CARD, sections: ["x".repeat(3_801)] },
			});
			await refused({ name: "x", content: "x", autoArchive: 5 });
			await refused({
				name: "x",
				content: "x",
				appliedTags: Array.from(
					{ length: 6 },
					(_, i) => `90000000000000000${i}`,
				),
			});
			await refused({ name: "x", content: "x", appliedTags: ["nope"] });
			await refused({
				name: "x",
				content: "x",
				mentions: ["not-an-id"],
			});
			expect(world.requests()).toBe(before);
			// A tag the forum does not offer is Discord's refusal, and the post is not made.
			await expectFailure(
				poster.createForumPost(forum, {
					name: "x",
					content: "x",
					appliedTags: ["900000000000099999"],
				}),
				"rejected",
			);
			const text = freshId();
			world.channel(text);
			await expectFailure(
				poster.createForumPost(text, { name: "x", content: "x" }),
				"invalid",
				{ reason: "not_forum" },
			);
			await expectFailure(
				poster.createForumPost("900000000000099999", {
					name: "x",
					content: "x",
				}),
				"channel_gone",
			);
			const made = await poster.createForumPost(forum, {
				name: "ok",
				content: "x",
				appliedTags: [bug.id],
			});
			expect(world.appliedTags(made.threadId)).toEqual([bug.id]);
		},
	},
	{
		name: "20. setPostTags: replaces a post's tags, clears them, and refuses a thread that is no forum post",
		async run({ poster, world }) {
			const { forum, bug, idea } = await taggedForum(poster, world);
			const post = await poster.createForumPost(forum, {
				name: "ticket",
				content: "first",
				appliedTags: [bug.id],
			});
			await poster.setPostTags(post.threadId, [idea.id]);
			expect(world.appliedTags(post.threadId)).toEqual([idea.id]);
			await poster.setPostTags(post.threadId, [bug.id, idea.id]);
			expect(world.appliedTags(post.threadId)).toEqual([bug.id, idea.id]);
			await poster.setPostTags(post.threadId, []);
			expect(world.appliedTags(post.threadId)).toEqual([]);
			const before = world.requests();
			await expectFailure(
				poster.setPostTags(post.threadId, ["nope"]),
				"invalid",
			);
			await expectFailure(
				poster.setPostTags(
					post.threadId,
					Array.from({ length: 6 }, (_, i) => `90000000000000000${i}`),
				),
				"invalid",
			);
			expect(world.requests()).toBe(before);
			await expectFailure(
				poster.setPostTags(post.threadId, ["900000000000099999"]),
				"rejected",
			);
			// A thread of a text channel is no forum post.
			const text = freshId();
			world.channel(text);
			const root = await poster.say(text, { content: "root" });
			const thread = await poster.startThread(text, root.messageId, "talk");
			await expectFailure(poster.setPostTags(thread, [bug.id]), "invalid", {
				reason: "not_forum",
			});
			await expectFailure(
				poster.setPostTags("900000000000099999", []),
				"channel_gone",
			);
		},
	},
	{
		name: "21. a card with a preview is a legacy message: the preview is its content, one embed and action rows; it is edited as that kind and cannot change kind",
		async run({ poster, world }) {
			const ch = freshId();
			world.channel(ch);
			const posted = await poster.sayCard(ch, {
				...PREVIEW,
				preview: "  Ticket 1\n  needs\ta look  ",
			});
			expect(world.isCard(ch, posted.messageId)).toBe(false);
			expect(world.legacyCard(ch, posted.messageId)).toEqual({
				content: "Ticket 1 needs a look",
				embeds: 1,
				title: "Ticket",
				color: 0x336699,
				rows: 2,
			});
			expect((await poster.message(ch, posted.messageId)).content).toBe(
				"Ticket 1 needs a look",
			);
			// An edit sets the content too, and a card without buttons or menus drops the rows.
			await poster.editCard(ch, posted.messageId, {
				title: "Ticket 2",
				sections: ["done"],
				preview: "Ticket 2 is done",
			});
			expect(world.legacyCard(ch, posted.messageId)).toEqual({
				content: "Ticket 2 is done",
				embeds: 1,
				title: "Ticket 2",
				color: undefined,
				rows: 0,
			});
			// A message keeps its kind: neither way can an edit change it.
			await expectFailure(
				poster.editCard(ch, posted.messageId, CARD),
				"rejected",
			);
			const v2 = await poster.sayCard(ch, CARD);
			await expectFailure(
				poster.editCard(ch, v2.messageId, PREVIEW),
				"rejected",
			);
			expect(world.isCard(ch, v2.messageId)).toBe(true);
			// A webhook posts and edits one the same way.
			const hooked = await poster.postCard(ch, {
				webhook: "relay",
				username: "Ann",
				card: PREVIEW,
			});
			expect(world.legacyCard(ch, hooked.messageId)).toMatchObject({
				content: "Ticket 1 needs a look",
				rows: 2,
			});
			await poster.editWebhookCard(
				ch,
				hooked.messageId,
				{ ...PREVIEW, preview: "changed", buttons: [], links: [] },
				["relay"],
			);
			expect(world.legacyCard(ch, hooked.messageId)).toMatchObject({
				content: "changed",
				rows: 1,
			});
			await expectFailure(
				poster.editWebhookCard(ch, hooked.messageId, CARD, ["relay"]),
				"rejected",
			);
		},
	},
	{
		name: "22. a preview card is checked before any request: the preview, the title, the rows and the text size",
		async run({ poster, world }) {
			const ch = freshId();
			world.channel(ch);
			const before = world.requests();
			const refused = (card: Partial<DiscordCard>) =>
				expectFailure(poster.sayCard(ch, { ...PREVIEW, ...card }), "invalid");
			await refused({ preview: "" });
			await refused({ preview: " \n\t " });
			await refused({ preview: "p".repeat(2_001) });
			await refused({ title: "t".repeat(257) });
			await refused({ sections: ["x".repeat(3_801)] });
			await refused({ thumbnail: { url: "http://img.example.test/t.png" } });
			await refused({
				selects: Array.from({ length: 5 }, (_, i) => ({
					customId: `pick:${i}`,
					placeholder: "State",
					options: [{ label: "Open", value: "open" }],
				})),
			});
			expect(world.requests()).toBe(before);
			// The longest preview and a title of 256 characters pass.
			await poster.sayCard(ch, {
				...PREVIEW,
				preview: "p".repeat(2_000),
				title: "t".repeat(256),
			});
			// A card in a forum post's first message may carry a preview too, and is edited by the post's ids.
			const forum = freshId();
			world.forum(forum);
			const post = await poster.createForumPost(forum, {
				name: "ticket",
				card: PREVIEW,
			});
			expect(world.legacyCard(post.threadId, post.messageId)).toMatchObject({
				content: "Ticket 1 needs a look",
				title: "Ticket",
			});
			await poster.editCard(post.threadId, post.messageId, {
				...PREVIEW,
				preview: "edited",
			});
			expect(world.legacyCard(post.threadId, post.messageId)?.content).toBe(
				"edited",
			);
		},
	},
];
