import { expect, test } from "bun:test";
import { DiscordAPIError } from "discord.js";
import type { DiscordPosterError } from "./poster-errors.ts";
import {
	type DiscordRest,
	type RestOptions,
	restPoster,
} from "./rest-poster.ts";

const GUILD = "900000000000000501";
const CATEGORY = "900000000000000502";
const FORUM = "900000000000000503";
const TEXT = "900000000000000504";
const POST = "900000000000000505";
const THREAD = "900000000000000506";
const VOICE = "900000000000000507";
const NEWS = "900000000000000508";
const MEDIA = "900000000000000509";
const DM = "900000000000000510";
const TAG = "900000000000000511";

const CHANNELS: Record<string, Record<string, unknown>> = {
	[CATEGORY]: { id: CATEGORY, type: 4, guild_id: GUILD },
	[FORUM]: {
		id: FORUM,
		type: 15,
		guild_id: GUILD,
		parent_id: CATEGORY,
		available_tags: [
			{
				id: TAG,
				name: "bug",
				moderated: true,
				emoji_id: null,
				emoji_name: "🐛",
			},
			{ id: "900000000000000512", name: "custom", emoji_id: "123" },
			{ name: "no id" },
		],
	},
	[TEXT]: { id: TEXT, type: 0, guild_id: GUILD },
	[POST]: { id: POST, type: 11, guild_id: GUILD, parent_id: FORUM },
	[THREAD]: { id: THREAD, type: 11, guild_id: GUILD, parent_id: TEXT },
	[VOICE]: { id: VOICE, type: 2, guild_id: GUILD },
	[NEWS]: { id: NEWS, type: 5, guild_id: GUILD },
	[MEDIA]: { id: MEDIA, type: 16, guild_id: GUILD },
	[DM]: { id: DM, type: 1 },
};

interface Sent {
	method: string;
	route: string;
	options?: RestOptions;
}

/** A Discord that knows `CHANNELS`, answers a post with its first message, and records every request. */
function forumRest(
	answer: (call: Sent) => unknown = () => undefined,
): DiscordRest & { sent: Sent[] } {
	const sent: Sent[] = [];
	const make =
		(method: string) => async (route: string, options?: RestOptions) => {
			const call = { method, route, ...(options ? { options } : {}) };
			sent.push(call);
			const given = answer(call);
			if (given instanceof Error) throw given;
			if (given !== undefined) return given;
			const channel = CHANNELS[route.replace("/channels/", "")];
			if (method === "GET" && channel) return channel;
			if (method === "POST" && route === `/channels/${FORUM}/threads`)
				return { id: POST, message: { id: POST } };
			if (method === "PATCH" && route === `/channels/${FORUM}`)
				return {
					...CHANNELS[FORUM],
					available_tags: (
						options?.body as { available_tags: unknown[] } | undefined
					)?.available_tags,
				};
			return {};
		};
	return {
		sent,
		get: make("GET"),
		post: make("POST"),
		patch: make("PATCH"),
		put: make("PUT"),
		delete: make("DELETE"),
	};
}

test("channelKind maps Discord's types, reads a thread's parent once, and keeps what it read", async () => {
	const rest = forumRest();
	const poster = restPoster(rest);
	const kinds = [];
	for (const id of [CATEGORY, FORUM, TEXT, POST, THREAD, VOICE, NEWS, MEDIA])
		kinds.push((await poster.channelKind(id)).kind);
	expect(kinds).toEqual([
		"category",
		"forum",
		"text",
		"forum_post",
		"thread",
		"other",
		"other",
		"other",
	]);
	expect(await poster.channelKind(FORUM)).toEqual({
		guildId: GUILD,
		kind: "forum",
		parentId: CATEGORY,
	});
	const reads = rest.sent.length;
	await poster.channelKind(POST);
	await poster.channelKind(THREAD);
	expect(rest.sent.length).toBe(reads);
});

test("channelKind of a direct-message channel is wrong_guild, and a channel Discord does not know is gone", async () => {
	const poster = restPoster(
		forumRest((call) =>
			call.route === "/channels/900000000000000999"
				? new DiscordAPIError(
						{ code: 10003, message: "Unknown Channel" },
						10003,
						404,
						"GET",
						"https://discord.test/x",
						{},
					)
				: undefined,
		),
	);
	const dm = await poster.channelKind(DM).catch((error) => error);
	expect((dm as DiscordPosterError).kind).toBe("invalid");
	expect((dm as DiscordPosterError).reason).toBe("wrong_guild");
	const gone = await poster
		.channelKind("900000000000000999")
		.catch((error) => error);
	expect((gone as DiscordPosterError).kind).toBe("channel_gone");
});

test("forumTags reads available_tags, with a Unicode or a custom emoji and no entry without an id or a name", async () => {
	const tags = await restPoster(forumRest()).forumTags(FORUM);
	expect(tags).toEqual([
		{ id: TAG, name: "bug", moderated: true, emoji: "🐛" },
		{
			id: "900000000000000512",
			name: "custom",
			moderated: false,
			emojiId: "123",
		},
	]);
});

test("setForumTags sends the whole set with its ids and null emoji, and returns what Discord answers", async () => {
	const rest = forumRest();
	const poster = restPoster(rest);
	await poster.setForumTags(FORUM, [
		{ id: TAG, name: "bug", moderated: true, emoji: "🐛" },
		{ name: "idea", emojiId: "900000000000000123" },
	]);
	const patch = rest.sent.find((call) => call.method === "PATCH");
	expect(patch?.route).toBe(`/channels/${FORUM}`);
	expect(patch?.options?.body).toEqual({
		available_tags: [
			{
				id: TAG,
				name: "bug",
				moderated: true,
				emoji_id: null,
				emoji_name: "🐛",
			},
			{
				name: "idea",
				moderated: false,
				emoji_id: "900000000000000123",
				emoji_name: null,
			},
		],
	});
});

test("a forum call on a channel that is no forum is not_forum and sends nothing", async () => {
	const rest = forumRest();
	const poster = restPoster(rest);
	for (const call of [
		() => poster.forumTags(TEXT),
		() => poster.setForumTags(TEXT, []),
		() => poster.createForumPost(TEXT, { name: "x", content: "x" }),
		() => poster.setPostTags(THREAD, []),
	]) {
		const error = (await call().catch(
			(thrown) => thrown,
		)) as DiscordPosterError;
		expect(error.kind).toBe("invalid");
		expect(error.reason).toBe("not_forum");
	}
	expect(rest.sent.filter((call) => call.method !== "GET")).toEqual([]);
});

test("createForumPost sends the name, archive time, tags and the first message in one request, and returns the post's id as both ids", async () => {
	const rest = forumRest();
	const poster = restPoster(rest);
	const made = await poster.createForumPost(FORUM, {
		name: "ticket 1",
		card: { title: "T", sections: ["a"] },
		appliedTags: [TAG],
		autoArchive: 4_320,
	});
	expect(made).toEqual({ threadId: POST, messageId: POST });
	const post = rest.sent.find((call) => call.method === "POST");
	expect(post?.route).toBe(`/channels/${FORUM}/threads`);
	const body = post?.options?.body as Record<string, unknown>;
	expect(body).toMatchObject({
		name: "ticket 1",
		auto_archive_duration: 4_320,
		applied_tags: [TAG],
	});
	expect(body.message).toMatchObject({ flags: 1 << 15 });
	// Text as the first message; no tags sends none; a week by default.
	await poster.createForumPost(FORUM, { name: "n", content: "hello" });
	const second = rest.sent.filter((call) => call.method === "POST")[1];
	const plain = second?.options?.body as Record<string, unknown>;
	expect(plain).not.toHaveProperty("applied_tags");
	expect(plain.auto_archive_duration).toBe(10_080);
	expect(plain.message).toMatchObject({
		content: "hello",
		allowed_mentions: { parse: [], users: [] },
	});
});

test("createForumPost falls back to the thread's id when Discord's answer holds no message, and fails when it holds no post", async () => {
	const noMessage = restPoster(
		forumRest((call) => (call.method === "POST" ? { id: POST } : undefined)),
	);
	expect(
		await noMessage.createForumPost(FORUM, { name: "n", content: "x" }),
	).toEqual({ threadId: POST, messageId: POST });
	const nothing = restPoster(
		forumRest((call) => (call.method === "POST" ? {} : undefined)),
	);
	const error = (await nothing
		.createForumPost(FORUM, { name: "n", content: "x" })
		.catch((thrown) => thrown)) as DiscordPosterError;
	expect(error.kind).toBe("rejected");
});

test("setPostTags patches applied_tags on the thread", async () => {
	const rest = forumRest();
	await restPoster(rest).setPostTags(POST, [TAG]);
	const patch = rest.sent.find((call) => call.method === "PATCH");
	expect(patch?.route).toBe(`/channels/${POST}`);
	// An archived post refuses new tags unless the same PATCH opens it again.
	expect(patch?.options?.body).toEqual({
		applied_tags: [TAG],
		archived: false,
	});
});

test("channelKind keeps a thread's parent but reads a channel's category afresh, so a moved channel is not stale", async () => {
	let category = CATEGORY;
	const rest = forumRest((call) =>
		call.method === "GET" && call.route === `/channels/${TEXT}`
			? { id: TEXT, type: 0, guild_id: GUILD, parent_id: category }
			: undefined,
	);
	const poster = restPoster(rest);
	expect((await poster.channelKind(TEXT)).parentId).toBe(CATEGORY);
	category = "900000000000000513";
	expect((await poster.channelKind(TEXT)).parentId).toBe("900000000000000513");
	// A thread's parent never changes: one read serves every later call.
	await poster.channelKind(POST);
	const reads = rest.sent.length;
	expect((await poster.channelKind(POST)).parentId).toBe(FORUM);
	expect(rest.sent.length).toBe(reads);
});

const ARCHIVED = () =>
	new DiscordAPIError(
		{ code: 50083, message: "Thread is archived" },
		50083,
		400,
		"PATCH",
		"https://discord.test/x",
		{},
	);

test("editCard opens an archived post for its first message and sends the edit again, and leaves another message's refusal alone", async () => {
	let refuse = true;
	const rest = forumRest((call) => {
		if (
			call.method === "PATCH" &&
			call.route.includes("/messages/") &&
			refuse
		) {
			refuse = false;
			return ARCHIVED();
		}
		return undefined;
	});
	const poster = restPoster(rest);
	await poster.editCard(POST, POST, { title: "T", sections: [] });
	expect(rest.sent.map((call) => `${call.method} ${call.route}`)).toEqual([
		`PATCH /channels/${POST}/messages/${POST}`,
		`PATCH /channels/${POST}`,
		`PATCH /channels/${POST}/messages/${POST}`,
	]);
	expect(rest.sent[1]?.options?.body).toEqual({ archived: false });
	// A reply is another message: Discord's refusal is the answer (rejected, 50083), nothing is opened.
	refuse = true;
	const before = rest.sent.length;
	const error = (await poster
		.editCard(POST, "900000000000000599", { title: "T", sections: [] })
		.catch((thrown) => thrown)) as DiscordPosterError;
	expect(error).toMatchObject({ kind: "rejected", discordCode: 50083 });
	expect(rest.sent.length).toBe(before + 1);
});

test("renameChannel sends archived: false for a thread only", async () => {
	const rest = forumRest();
	const poster = restPoster(rest);
	await poster.renameChannel(POST, "done");
	await poster.renameChannel(TEXT, "general");
	const bodies = rest.sent
		.filter((call) => call.method === "PATCH")
		.map((call) => call.options?.body);
	expect(bodies).toEqual([
		{ name: "done", archived: false },
		{ name: "general" },
	]);
});
