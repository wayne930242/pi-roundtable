import { REST } from "discord.js";
import { DiscordEmulator } from "../../testing/discord-api-emulator.ts";
import {
	BOT_TOKEN,
	COMPONENTS_V2,
} from "../../testing/discord-api-emulator-state.ts";
import type { PosterSubject } from "./poster-contract-support.ts";
import { restOf, restPoster } from "./rest-poster.ts";

const GUILD = "900000000000000001";
const OWNER = "900000000000000002";
const STRANGER = "900000000000000555";
const ADMINISTRATOR = String(1n << 3n);
const VIEW_CHANNEL = String(1n << 10n);

/** A real poster over discord.js' REST client, talking to the emulated Discord. */
export function restSubject(
	options: { renameRetryAfter?: number } = {},
): PosterSubject & { emulator: DiscordEmulator } {
	const emulator = new DiscordEmulator();
	emulator.start();
	emulator.state.renameRetryAfter = options.renameRetryAfter ?? 1;
	emulator.addGuild(GUILD, OWNER);
	const rest = new REST({ version: "10", api: emulator.api, timeout: 5_000 });
	rest.setToken(BOT_TOKEN);
	const poster = restPoster(restOf(rest), { renameWaitMs: 200 });
	const guild = () => emulator.state.guilds.get(GUILD);
	const message = (channelId: string, messageId: string) =>
		emulator.state.channels
			.get(channelId)
			?.messages.find((entry) => entry.id === messageId);
	return {
		poster,
		emulator,
		close: () => emulator.stop(),
		world: {
			guildId: GUILD,
			channel: (id) => void emulator.addChannel(id, GUILD),
			category: (id) => void emulator.addChannel(id, GUILD, { type: 4 }),
			member: (userId, names) =>
				void guild()?.members.set(userId, {
					userId,
					username: names.username,
					roles: [],
					...(names.nick ? { nick: names.nick } : {}),
					...(names.global ? { globalName: names.global } : {}),
				}),
			viewCase: (channelId, userId, how) => {
				const found = guild();
				const channel = emulator.state.channels.get(channelId);
				if (!(found && channel)) throw new Error("no such guild or channel");
				found.ownerId = how === "owner" ? userId : OWNER;
				// Everyone is denied the channel, so only the case's own rule can let a member in.
				channel.overwrites = [
					{ id: GUILD, type: 0, allow: "0", deny: VIEW_CHANNEL },
				];
				if (how !== "non-member")
					found.members.set(userId, { userId, username: "u", roles: [] });
				if (how === "administrator") {
					found.roles.push({ id: `${userId}1`, permissions: ADMINISTRATOR });
					found.members.set(userId, {
						userId,
						username: "u",
						roles: [`${userId}1`],
					});
				}
				if (how === "member-allowed")
					channel.overwrites.push({
						id: userId,
						type: 1,
						allow: VIEW_CHANNEL,
						deny: "0",
					});
				return how !== "member-denied" && how !== "non-member";
			},
			foreignWebhook: (channelId, name) => {
				const id = `${channelId}9`;
				emulator.state.webhooks.set(id, {
					id,
					token: "foreign-token",
					channelId,
					name,
					userId: STRANGER,
				});
				return id;
			},
			deleteWebhook: (channelId, name) =>
				emulator.deleteWebhook(channelId, name),
			closeDirects: (userId) => void emulator.state.closedDirects.add(userId),
			personArchives: (threadId, userId, given) =>
				emulator.personArchives(threadId, userId, {
					...(given?.lock ? { lock: true } : {}),
					...(given?.auditSkew === undefined
						? {}
						: { skewMs: given.auditSkew }),
				}),
			autoArchive: (threadId) => emulator.autoArchives(threadId),
			auditLog: (readable) => {
				emulator.state.auditReadable = readable;
			},
			pinNotices: (on) => {
				emulator.state.pinNotices = on;
			},
			categoryLimit: (limit) => {
				emulator.state.categoryLimit = limit;
			},
			mentionsOf: (channelId, messageId) =>
				emulator.mentionsOf(channelId, messageId),
			directMentions: (userId) =>
				emulator
					.directsTo(userId)
					.map((direct) => direct.allowedMentions as never),
			autoArchiveMinutes: (threadId) =>
				emulator.state.channels.get(threadId)?.thread?.autoArchiveDuration,
			isCard: (channelId, messageId) => {
				const found = message(channelId, messageId);
				return (
					found !== undefined &&
					(found.flags & COMPONENTS_V2) !== 0 &&
					found.components !== undefined
				);
			},
			requests: () => emulator.requests,
		},
	};
}
