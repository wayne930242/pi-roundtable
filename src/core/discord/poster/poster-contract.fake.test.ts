import { fakeDiscordPoster } from "../../testing/fake-poster.ts";
import { checkTitleUrl } from "./poster-card-parts.ts";
import { cardBody } from "./poster-checks.ts";
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
			forum: (id) => {
				fake.channels.set(id, {
					name: undefined,
					parentId: undefined,
					topic: "",
					messages: [],
					pins: [],
					avatars: new Map(),
				});
				fake.forums.set(id, { tags: [] });
			},
			member: (userId, names) =>
				void fake.memberNames.set(
					userId,
					names.nick ?? names.global ?? names.username,
				),
			role: (role) =>
				void fake.roles.set(role.id, { ...role, managed: role.managed === true }),
			botRoles: (ids) => {
				fake.botRoles = [...ids];
			},
			holdRoles: (userId, ids) => void fake.memberRoleIds.set(userId, [...ids]),
			rolesHeldBy: (userId) => fake.memberRoleIds.get(userId) ?? [],
			roleIdsNamed: (name) =>
				[...fake.roles.values()]
					.filter((role) => role.name === name)
					.map((role) => role.id),
			roleChanges: () =>
				fake.roleChanges.map(({ action, roleId, userId, reason }) => ({
					action,
					roleId,
					reason,
					...(userId ? { userId } : {}),
				})),
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
			isCard: (channelId, messageId) => {
				const card = fake
					.messagesIn(channelId)
					.find((message) => message.id === messageId)?.card;
				return card !== undefined && card.preview === undefined;
			},
			cardHeading: (channelId, messageId) => {
				const card = fake
					.messagesIn(channelId)
					.find((entry) => entry.id === messageId)?.card;
				if (!card || card.preview !== undefined) return undefined;
				const [container] = cardBody(card).components as unknown as {
					components: {
						type: number;
						content?: string;
						components?: { content?: string }[];
					}[];
				}[];
				const first = container?.components[0];
				return first?.type === 9
					? first.components?.[0]?.content
					: first?.content;
			},
			legacyCard: (channelId, messageId) => {
				const message = fake
					.messagesIn(channelId)
					.find((entry) => entry.id === messageId);
				const card = message?.card;
				if (!(message && card) || card.preview === undefined) return undefined;
				return {
					content: message.content,
					embeds: 1,
					title: card.title,
					url:
						card.titleUrl === undefined
							? undefined
							: checkTitleUrl(card.titleUrl),
					color: card.accent,
					rows:
						(card.selects?.length ?? 0) +
						((card.buttons?.length ?? 0) + (card.links?.length ?? 0) > 0
							? 1
							: 0),
				};
			},
			appliedTags: (threadId) => fake.channels.get(threadId)?.appliedTags ?? [],
			requests: () => fake.requests,
		},
	};
}

runContract("fake", fakeSubject);
