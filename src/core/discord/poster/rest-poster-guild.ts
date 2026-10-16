import { AuditLogEvent, RESTJSONErrorCodes, Routes } from "discord.js";
import type { DiscordPoster } from "./poster.ts";
import { checkChannelName, checkSnowflake } from "./poster-checks.ts";
import { DiscordPosterError, failure, isCode } from "./poster-errors.ts";
import { object, type RestCore, text } from "./rest-poster-core.ts";

/** How long a rename waits: past Discord's limit on renames the request would be held for minutes. */
export const RENAME_WAIT_MS = 10_000;

/** How close an audit entry's time must be to the thread's archive time for the entry to be that archive. */
const AUDIT_MATCH_MS = 2 * 60_000;

/** After how many minutes without a message Discord archives a thread: a week, the longest it offers. */
const THREAD_ARCHIVE_MINUTES = 10_080;

const ADMINISTRATOR = 1n << 3n;
const VIEW_CHANNEL = 1n << 10n;

/** Discord's rule for whether a member can see a channel: owner and administrators always, else the roles and the channel's overwrites. */
export function canViewChannel(input: {
	guildId: string;
	userId: string;
	ownerId: string | undefined;
	memberRoles: readonly string[];
	roles: readonly Record<string, unknown>[];
	overwrites: readonly Record<string, unknown>[];
}): boolean {
	if (input.ownerId === input.userId) return true;
	const permissions = (value: unknown): bigint => {
		try {
			return typeof value === "string" || typeof value === "number"
				? BigInt(value)
				: 0n;
		} catch {
			return 0n;
		}
	};
	// The @everyone role has the guild's id.
	let base = 0n;
	for (const role of input.roles) {
		const id = text(role.id);
		if (id === input.guildId || (id && input.memberRoles.includes(id)))
			base |= permissions(role.permissions);
	}
	if ((base & ADMINISTRATOR) !== 0n) return true;
	let allowed = base;
	const overwrite = (type: number, id: string) =>
		input.overwrites.find(
			(entry) => entry.type === type && text(entry.id) === id,
		);
	const apply = (entry: Record<string, unknown> | undefined) => {
		if (!entry) return;
		allowed = (allowed & ~permissions(entry.deny)) | permissions(entry.allow);
	};
	apply(overwrite(0, input.guildId));
	let deny = 0n;
	let allow = 0n;
	for (const roleId of input.memberRoles) {
		const entry = overwrite(0, roleId);
		if (!entry) continue;
		deny |= permissions(entry.deny);
		allow |= permissions(entry.allow);
	}
	allowed = (allowed & ~deny) | allow;
	apply(overwrite(1, input.userId));
	return (allowed & VIEW_CHANNEL) !== 0n;
}

/** The poster's channel, thread, member and permission calls. */
export type GuildOperations = Pick<
	DiscordPoster,
	| "createTextChannel"
	| "textChannels"
	| "deleteChannel"
	| "renameChannel"
	| "startThread"
	| "setThreadArchived"
	| "threadState"
	| "threadCloser"
	| "channelGuild"
	| "canView"
	| "memberName"
>;

export function guildOperations(
	core: RestCore,
	options: { renameWaitMs?: number } = {},
): GuildOperations {
	const { rest } = core;
	const renameWaitMs = options.renameWaitMs ?? RENAME_WAIT_MS;
	return {
		async channelGuild(channelId) {
			checkSnowflake("a channel", channelId);
			return (await core.readChannel(channelId)).guildId;
		},
		async createTextChannel(categoryId, name, topic) {
			checkSnowflake("a category", categoryId);
			checkChannelName("a channel name", name);
			const guildId = await core.guildOf(categoryId);
			// No permission overwrites: the channel is made under the category and takes its permissions.
			const made = object(
				await rest
					.post(Routes.guildChannels(guildId), {
						body: {
							name,
							type: 0,
							parent_id: categoryId,
							...(topic ? { topic } : {}),
						},
					})
					.catch((error: unknown) => {
						throw failure("making a channel", error);
					}),
			);
			const id = text(made.id);
			if (!id)
				throw new DiscordPosterError("rejected", "Discord made no channel");
			return id;
		},
		async textChannels(categoryId) {
			checkSnowflake("a category", categoryId);
			const guildId = await core.guildOf(categoryId);
			const listed = await rest
				.get(Routes.guildChannels(guildId))
				.catch((error: unknown) => {
					throw failure("listing the guild's channels", error);
				});
			return (Array.isArray(listed) ? listed : []).flatMap((entry) => {
				const channel = object(entry);
				const id = text(channel.id);
				const name = text(channel.name);
				return channel.parent_id === categoryId &&
					channel.type === 0 &&
					id &&
					name
					? [{ id, name, topic: text(channel.topic) ?? "" }]
					: [];
			});
		},
		async deleteChannel(channelId) {
			checkSnowflake("a channel", channelId);
			await rest.delete(Routes.channel(channelId)).catch((error: unknown) => {
				throw failure("deleting a channel", error);
			});
		},
		async renameChannel(channelId, name) {
			checkSnowflake("a channel", channelId);
			checkChannelName("a channel name", name);
			// discord.js sleeps out a rate limit's wait (a rename sublimit can be minutes) without
			// looking at the signal, so the call is also raced against a timer: the caller is freed
			// at once, and the signal keeps the held request from being sent later.
			let timer: ReturnType<typeof setTimeout> | undefined;
			const patch = rest
				.patch(Routes.channel(channelId), {
					body: { name },
					signal: AbortSignal.timeout(renameWaitMs),
				})
				.catch((error: unknown) => {
					throw failure("renaming a channel", error);
				});
			// A late failure of the abandoned request is not an unhandled rejection.
			patch.catch(() => undefined);
			try {
				await Promise.race([
					patch,
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() =>
								reject(
									new DiscordPosterError(
										"unavailable",
										"renaming a channel failed (held back by Discord's rate limit)",
									),
								),
							renameWaitMs,
						);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		},
		async startThread(channelId, messageId, name) {
			checkSnowflake("a channel", channelId);
			checkSnowflake("a message", messageId);
			checkChannelName("a thread name", name);
			const made = object(
				await rest
					.post(Routes.threads(channelId, messageId), {
						body: { name, auto_archive_duration: THREAD_ARCHIVE_MINUTES },
					})
					.catch((error: unknown) => {
						throw failure("starting a thread", error);
					}),
			);
			const id = text(made.id);
			if (!id)
				throw new DiscordPosterError("rejected", "Discord made no thread");
			return id;
		},
		async setThreadArchived(threadId, archived) {
			checkSnowflake("a thread", threadId);
			await rest
				.patch(Routes.channel(threadId), { body: { archived } })
				.catch((error: unknown) => {
					throw failure("changing a thread's archive state", error);
				});
		},
		async threadState(threadId) {
			checkSnowflake("a thread", threadId);
			const channel = object(
				await rest.get(Routes.channel(threadId)).catch((error: unknown) => {
					throw failure("reading a thread", error);
				}),
			);
			const meta = object(channel.thread_metadata);
			const archivedAt = Date.parse(text(meta.archive_timestamp) ?? "");
			return {
				archived: meta.archived === true,
				locked: meta.locked === true,
				archivedAt: Number.isNaN(archivedAt) ? undefined : archivedAt,
			};
		},
		async threadCloser(threadId, state) {
			checkSnowflake("a thread", threadId);
			const { guildId } = await core.readChannel(threadId);
			const log = object(
				await rest
					.get(Routes.guildAuditLog(guildId), {
						query: new URLSearchParams({
							action_type: String(AuditLogEvent.ThreadUpdate),
							limit: "50",
						}),
					})
					.catch((error: unknown) => {
						throw failure("reading the guild's audit log", error);
					}),
			);
			const entries = Array.isArray(log.audit_log_entries)
				? log.audit_log_entries
				: [];
			// Newest first. An entry counts when it is about this thread, turns on the archive or the
			// lock, and (for an archive) is of the moment the thread was archived: an older entry of an
			// archive that was since undone says nothing about this one.
			for (const raw of entries) {
				const entry = object(raw);
				if (text(entry.target_id) !== threadId) continue;
				const changes = Array.isArray(entry.changes) ? entry.changes : [];
				const turnedOn = (key: string) =>
					changes.some((change) => {
						const found = object(change);
						return found.key === key && found.new_value === true;
					});
				const archives = state.archived && turnedOn("archived");
				const locks = state.locked && turnedOn("locked");
				if (!archives && !locks) continue;
				const id = text(entry.id);
				if (archives && !locks) {
					if (!id || state.archivedAt === undefined) continue;
					const at = Number((BigInt(id) >> 22n) + 1_420_070_400_000n);
					if (Math.abs(at - state.archivedAt) > AUDIT_MATCH_MS) continue;
				}
				const userId = text(entry.user_id);
				if (!userId) continue;
				return userId === (await core.bot())
					? { kind: "bot" }
					: { kind: "person", userId };
			}
			return { kind: "unknown" };
		},
		async canView(channelId, userId) {
			checkSnowflake("a channel", channelId);
			checkSnowflake("a user", userId);
			const channel = object(
				await rest.get(Routes.channel(channelId)).catch((error: unknown) => {
					throw failure("reading a channel", error);
				}),
			);
			const guildId = text(channel.guild_id);
			if (!guildId)
				throw new DiscordPosterError("invalid", "that channel is in no guild", {
					reason: "wrong_guild",
				});
			let member: Record<string, unknown>;
			try {
				member = object(await rest.get(Routes.guildMember(guildId, userId)));
			} catch (error) {
				if (isCode(error, RESTJSONErrorCodes.UnknownMember)) return false;
				throw failure("reading a guild member", error);
			}
			const guild = object(
				await rest.get(Routes.guild(guildId)).catch((error: unknown) => {
					throw failure("reading the guild", error);
				}),
			);
			const roles = await rest
				.get(Routes.guildRoles(guildId))
				.catch((error: unknown) => {
					throw failure("listing the guild's roles", error);
				});
			return canViewChannel({
				guildId,
				userId,
				ownerId: text(guild.owner_id),
				memberRoles: Array.isArray(member.roles)
					? member.roles.filter((id): id is string => typeof id === "string")
					: [],
				roles: Array.isArray(roles) ? roles.map(object) : [],
				overwrites: Array.isArray(channel.permission_overwrites)
					? channel.permission_overwrites.map(object)
					: [],
			});
		},
		async memberName(guildId, userId) {
			checkSnowflake("a guild", guildId);
			checkSnowflake("a user", userId);
			let member: Record<string, unknown>;
			try {
				member = object(await rest.get(Routes.guildMember(guildId, userId)));
			} catch (error) {
				// Not in the guild: an answer, not a failure.
				if (isCode(error, RESTJSONErrorCodes.UnknownMember)) return undefined;
				throw failure("reading a guild member", error);
			}
			const user = object(member.user);
			return text(member.nick) ?? text(user.global_name) ?? text(user.username);
		},
	};
}
