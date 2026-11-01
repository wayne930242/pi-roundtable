import { expect, test } from "bun:test";
import { DiscordPosterError } from "../discord/poster/poster-errors.ts";
import { fakeDiscordPoster } from "./fake-poster.ts";

const CHANNEL = "900000000000000401";
const USER = "900000000000000402";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("the fake keeps what was posted, edited, pinned and deleted, with the webhook that posted it", async () => {
	const poster = fakeDiscordPoster();
	const first = await poster.post(CHANNEL, {
		webhook: "relay",
		username: "Ann",
		content: "hello",
		mentions: [USER],
		files: [{ name: "a.png", data: new Uint8Array(3) }],
	});
	await poster.edit(CHANNEL, first.messageId, { content: "hello again" }, [
		"relay",
	]);
	await poster.pin(CHANNEL, first.messageId);
	const ids = await poster.webhookIds(CHANNEL, ["relay"]);
	expect(poster.messagesIn(CHANNEL)).toMatchObject([
		{
			id: first.messageId,
			username: "Ann",
			content: "hello again",
			files: [{ name: "a.png", bytes: 3 }],
			mentions: [],
			webhook: "relay",
			webhookId: ids.relay?.[0],
		},
	]);
	expect(poster.channels.get(CHANNEL)?.pins).toEqual([first.messageId]);
	await poster.remove(CHANNEL, first.messageId, ["relay"]);
	expect(poster.messagesIn(CHANNEL)).toEqual([]);
	expect(poster.channels.get(CHANNEL)?.pins).toEqual([]);
});

test("a person's words are kept as theirs, and a pin notice appears only when asked", async () => {
	const poster = fakeDiscordPoster();
	const said = poster.speak(
		CHANNEL,
		{ id: USER, name: "Bo" },
		"hi",
		[],
		["https://files.test/x"],
	);
	const read = await poster.message(CHANNEL, said);
	expect(read).toMatchObject({ authorId: USER, content: "hi" });
	await poster.pin(CHANNEL, said);
	expect(poster.messagesIn(CHANNEL)).toHaveLength(1);
	poster.pinNotices = true;
	await poster.unpin(CHANNEL, said);
	await poster.pin(CHANNEL, said);
	expect(poster.messagesIn(CHANNEL).map((m) => m.type)).toEqual([undefined, 6]);
});

test("failNext fails the next call of an operation once, and the call counts as a request only past its checks", async () => {
	const poster = fakeDiscordPoster();
	poster.failNext("say", new DiscordPosterError("forbidden", "no"));
	await expect(poster.say(CHANNEL, { content: "x" })).rejects.toMatchObject({
		kind: "forbidden",
	});
	await poster.say(CHANNEL, { content: "x" });
	const before = poster.requests;
	await expect(poster.say(CHANNEL, { content: "" })).rejects.toMatchObject({
		kind: "invalid",
	});
	expect(poster.requests).toBe(before);
	poster.goneChannels.add(CHANNEL);
	await expect(poster.say(CHANNEL, { content: "x" })).rejects.toMatchObject({
		kind: "channel_gone",
	});
});

test("the rename limit follows the clock the test gives", async () => {
	let now = 0;
	const poster = fakeDiscordPoster({ now: () => now });
	await poster.renameChannel(CHANNEL, "a");
	await poster.renameChannel(CHANNEL, "b");
	await expect(poster.renameChannel(CHANNEL, "c")).rejects.toMatchObject({
		kind: "unavailable",
	});
	now += 10 * 60_000;
	await poster.renameChannel(CHANNEL, "c");
	expect(poster.renames.map(([, name]) => name)).toEqual(["a", "b", "c"]);
});

test("a webhook made again is announced, forgets its picture and keeps the old messages out of reach of an edit", async () => {
	const poster = fakeDiscordPoster();
	const heard: string[] = [];
	poster.onWebhookMade(
		async (channel, name) => void heard.push(`${channel}:${name}`),
	);
	const old = await poster.post(CHANNEL, {
		webhook: "relay",
		username: "A",
		content: "x",
	});
	await poster.setAvatar(CHANNEL, "relay", PNG);
	expect(poster.channels.get(CHANNEL)?.avatars.get("relay")).toEqual(PNG);
	await poster.recreateWebhook(CHANNEL, "relay");
	expect(poster.channels.get(CHANNEL)?.avatars.has("relay")).toBe(false);
	expect(heard).toEqual([`${CHANNEL}:relay`, `${CHANNEL}:relay`]);
	await expect(
		poster.edit(CHANNEL, old.messageId, { content: "y" }, ["relay"]),
	).rejects.toMatchObject({ kind: "message_gone" });
	await poster.remove(CHANNEL, old.messageId, ["relay"]);
	expect(poster.messagesIn(CHANNEL)).toEqual([]);
});

test("ids move with idOffset, so two fakes of one database never meet", async () => {
	const one = await fakeDiscordPoster().say(CHANNEL, { content: "x" });
	const other = await fakeDiscordPoster({ idOffset: 1_000n }).say(CHANNEL, {
		content: "x",
	});
	expect(one.messageId).not.toBe(other.messageId);
});

test("members, views and guilds are what the test sets", async () => {
	const poster = fakeDiscordPoster();
	poster.memberNames.set(USER, "Bo");
	expect(await poster.memberName(poster.guildId, USER)).toBe("Bo");
	expect(poster.memberLookups).toEqual([
		{ guildId: poster.guildId, userId: USER },
	]);
	poster.hiddenFrom.add(`${CHANNEL}:${USER}`);
	expect(await poster.canView(CHANNEL, USER)).toBe(false);
	poster.channelGuilds.set(CHANNEL, "900000000000000999");
	expect(await poster.channelGuild(CHANNEL)).toBe("900000000000000999");
	poster.categories.add("900000000000000500");
	await poster.createTextChannel("900000000000000500", "alpha");
	expect(
		await poster
			.threadState("900000000000099998")
			.catch((e: DiscordPosterError) => e.kind),
	).toBe("channel_gone");
});

const FORUM = "900000000000000411";

/** A fake with one forum registered the way a test does it. */
function withForum() {
	const poster = fakeDiscordPoster();
	poster.channels.set(FORUM, {
		name: "tickets",
		parentId: undefined,
		topic: "",
		messages: [],
		pins: [],
		avatars: new Map(),
	});
	poster.forums.set(FORUM, { tags: [] });
	return poster;
}

test("a forum post keeps its first message under the thread's own id, with its tags and archive time", async () => {
	const poster = withForum();
	const [bug] = await poster.setForumTags(FORUM, [{ name: "bug" }]);
	const made = await poster.createForumPost(FORUM, {
		name: "ticket",
		card: { title: "T", sections: ["a"] },
		appliedTags: [bug?.id ?? ""],
	});
	expect(made.messageId).toBe(made.threadId);
	const channel = poster.channels.get(made.threadId);
	expect(channel).toMatchObject({
		name: "ticket",
		parentId: FORUM,
		startedOn: made.messageId,
		autoArchiveMinutes: 10_080,
		appliedTags: [bug?.id],
	});
	expect(poster.messagesIn(made.threadId)).toMatchObject([
		{ id: made.messageId, card: { title: "T" }, authorId: poster.botId },
	]);
	// Posts are threads: they are not listed as the channels of a category.
	expect(poster.threadsIn(FORUM)).toMatchObject([
		{ id: made.threadId, name: "ticket", startedOn: made.messageId },
	]);
});

test("a forum call needs a registered forum: another channel is not_forum, an unknown one gone, and a call that fails first counts no request", async () => {
	const poster = withForum();
	poster.speak(CHANNEL, { id: USER, name: "Bo" }, "hi");
	const error = await poster
		.createForumPost(CHANNEL, { name: "x", content: "x" })
		.catch((thrown) => thrown);
	expect(error).toMatchObject({ kind: "invalid", reason: "not_forum" });
	const gone = await poster
		.forumTags("900000000000000499")
		.catch((thrown) => thrown);
	expect(gone).toMatchObject({ kind: "channel_gone" });
	const before = poster.requests;
	await poster
		.createForumPost(FORUM, { name: "", content: "x" })
		.catch(() => undefined);
	expect(poster.requests).toBe(before);
	poster.failNext(
		"createForumPost",
		new DiscordPosterError("forbidden", "missing Create Posts"),
	);
	const forbidden = await poster
		.createForumPost(FORUM, { name: "x", content: "x" })
		.catch((thrown) => thrown);
	expect(forbidden).toMatchObject({ kind: "forbidden" });
	expect(poster.threadsIn(FORUM)).toEqual([]);
});

test("a preview card is held with its preview as the message content, in a post as anywhere", async () => {
	const poster = withForum();
	const card = { title: "T", sections: ["a"], preview: "one\n two" };
	const said = await poster.sayCard(CHANNEL, card);
	expect(poster.messagesIn(CHANNEL)).toMatchObject([
		{ id: said.messageId, content: "one two", card },
	]);
	const made = await poster.createForumPost(FORUM, { name: "p", card });
	expect(poster.messagesIn(made.threadId)[0]?.content).toBe("one two");
	await poster.editCard(CHANNEL, said.messageId, { ...card, preview: "three" });
	expect(poster.messagesIn(CHANNEL)[0]?.content).toBe("three");
	// The text of a card without a preview is still the card as plain text.
	const v2 = await poster.sayCard(CHANNEL, { title: "T", sections: ["a"] });
	expect(
		poster.messagesIn(CHANNEL).find((m) => m.id === v2.messageId)?.content,
	).toBe("### T\na");
});

test("channelKind in the fake follows what a test registered: categories, forums, threads and forum posts", async () => {
	const poster = withForum();
	poster.categories.add("900000000000000412");
	poster.channelGuilds.set(FORUM, "700000000000000002");
	expect(await poster.channelKind("900000000000000412")).toEqual({
		guildId: poster.guildId,
		kind: "category",
	});
	expect(await poster.channelKind(FORUM)).toEqual({
		guildId: "700000000000000002",
		kind: "forum",
	});
	const made = await poster.createForumPost(FORUM, { name: "p", content: "x" });
	expect(await poster.channelKind(made.threadId)).toMatchObject({
		kind: "forum_post",
		parentId: FORUM,
	});
	poster.goneChannels.add(FORUM);
	await expect(poster.channelKind(FORUM)).rejects.toMatchObject({
		kind: "channel_gone",
	});
});
