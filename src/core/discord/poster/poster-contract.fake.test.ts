import { fakeDiscordPoster } from "../../testing/fake-poster.ts";
import { runContract } from "./poster-contract.ts";
import type { PosterSubject } from "./poster-contract-support.ts";

function fakeSubject(): PosterSubject {
	const fake = fakeDiscordPoster();
	return {
		poster: fake,
		close: () => undefined,
		world: {
			guildId: fake.guildId,
			channel: (id) =>
				void fake.channels.set(id, {
					name: undefined,
					parentId: undefined,
					topic: "",
					messages: [],
					pins: [],
					avatars: new Map(),
				}),
			category: (id) => void fake.categories.add(id),
			member: (userId, names) =>
				void fake.memberNames.set(
					userId,
					names.nick ?? names.global ?? names.username,
				),
			viewCase: (channelId, userId, how) => {
				if (how === "member-denied")
					fake.hiddenFrom.add(`${channelId}:${userId}`);
				if (how === "non-member") fake.nonMembers.add(userId);
				return how !== "member-denied" && how !== "non-member";
			},
			// The fake only ever sees the webhooks it made itself.
			foreignWebhook: () => "900000000000000555",
			deleteWebhook: (channelId, name) => fake.deleteWebhook(channelId, name),
			closeDirects: (userId) => void fake.closedDirects.add(userId),
			personArchives: (threadId, userId, options) =>
				fake.personCloses(threadId, userId, options),
			autoArchive: (threadId) => fake.autoArchives(threadId),
			auditLog: (readable) => {
				fake.canReadAuditLog = readable;
			},
			pinNotices: (on) => {
				fake.pinNotices = on;
			},
			categoryLimit: (limit) => {
				fake.categoryLimit = limit;
			},
			mentionsOf: (channelId, messageId) => {
				const found = fake
					.messagesIn(channelId)
					.find((message) => message.id === messageId);
				return found ? { parse: [], users: found.mentions } : undefined;
			},
			directMentions: (userId) =>
				fake.directs
					.filter((direct) => direct.userId === userId)
					.map(() => ({ parse: [], users: [] })),
			autoArchiveMinutes: (threadId) =>
				fake.channels.get(threadId)?.autoArchiveMinutes,
			isCard: (channelId, messageId) =>
				fake.messagesIn(channelId).find((message) => message.id === messageId)
					?.card !== undefined,
			requests: () => fake.requests,
		},
	};
}

runContract("fake", fakeSubject);
