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
