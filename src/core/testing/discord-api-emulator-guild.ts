import {
	auditId,
	BOT_ID,
	channelJson,
	type EmuChannel,
	type EmuState,
	formError,
	HttpError,
	missingPermissions,
	newId,
	str,
	unknownChannel,
	unknownMessage,
} from "./discord-api-emulator-state.ts";

/** One request, parsed. */
export interface Ctx {
	/** The captures of the route's pattern. */
	params: string[];
	query: URLSearchParams;
	body: Record<string, unknown>;
}

export type Route = [
	method: string,
	pattern: RegExp,
	handle: (ctx: Ctx) => unknown,
];

/** Discord lets a channel be renamed twice in ten minutes. */
const RENAME_WINDOW_MS = 10 * 60_000;

export function channelOf(state: EmuState, id: string | undefined): EmuChannel {
	const channel = id ? state.channels.get(id) : undefined;
	if (!channel) throw unknownChannel();
	return channel;
}

/** Records who changed a thread's archive or lock, as the audit log would. */
export function logThread(
	state: EmuState,
	thread: EmuChannel,
	userId: string,
	change: { key: "archived" | "locked"; value: boolean },
	entryId: string,
): void {
	if (!thread.guildId) return;
	const log = state.audit.get(thread.guildId) ?? [];
	log.push({
		id: entryId,
		targetId: thread.id,
		userId,
		changes: [{ key: change.key, new_value: change.value }],
	});
	state.audit.set(thread.guildId, log);
}

function rateLimited(state: EmuState): HttpError {
	return new HttpError(
		429,
		0,
		"You are being rate limited.",
		undefined,
		{
			"Retry-After": String(state.renameRetryAfter),
			"X-RateLimit-Scope": "shared",
		},
		{ retry_after: state.renameRetryAfter, global: false },
	);
}

/** Channels, threads, members, roles and the audit log. */
export function guildRoutes(state: EmuState): Route[] {
	const guildOf = (id: string | undefined) => {
		const guild = id ? state.guilds.get(id) : undefined;
		if (!guild) throw new HttpError(404, 10004, "Unknown Guild");
		return guild;
	};
	return [
		["GET", /^\/users\/@me$/, () => ({ id: BOT_ID, username: "relay-bot" })],
		[
			"POST",
			/^\/users\/@me\/channels$/,
			({ body }) => {
				const userId = str(body.recipient_id);
				if (!userId)
					throw formError("recipient_id", "BASE_TYPE_REQUIRED", "required");
				const existing = [...state.channels.values()].find(
					(channel) => channel.type === 1 && channel.recipientId === userId,
				);
				if (existing) return channelJson(existing);
				const channel: EmuChannel = {
					id: newId(state),
					type: 1,
					name: "",
					overwrites: [],
					messages: [],
					pins: [],
					renames: [],
					recipientId: userId,
				};
				state.channels.set(channel.id, channel);
				return channelJson(channel);
			},
		],
		[
			"GET",
			/^\/channels\/(\d+)$/,
			({ params }) => channelJson(channelOf(state, params[0])),
		],
		[
			"PATCH",
			/^\/channels\/(\d+)$/,
			({ params, body }) => {
				const channel = channelOf(state, params[0]);
				const name = str(body.name);
				if (name) {
					// The sublimit on renames: a third inside ten minutes is answered with a long wait.
					const now = Date.now();
					const recent = channel.renames.filter(
						(at) => now - at < RENAME_WINDOW_MS,
					);
					if (recent.length >= 2) throw rateLimited(state);
					channel.renames = [...recent, now];
					channel.name = name;
				}
				if (typeof body.archived === "boolean" && channel.thread) {
					const thread = channel.thread;
					// The bot started its threads, so it needs no Manage Threads, except to open a locked one.
					if (!body.archived && thread.locked) throw missingPermissions();
					if (body.archived !== thread.archived) {
						thread.archived = body.archived;
						if (body.archived) {
							thread.archiveTimestamp = Date.now();
							logThread(
								state,
								channel,
								BOT_ID,
								{ key: "archived", value: true },
								auditId(state, Date.now()),
							);
						}
					}
				}
				return channelJson(channel);
			},
		],
		[
			"DELETE",
			/^\/channels\/(\d+)$/,
			({ params }) => {
				const channel = channelOf(state, params[0]);
				state.channels.delete(channel.id);
				return channelJson(channel);
			},
		],
		[
			"POST",
			/^\/channels\/(\d+)\/messages\/(\d+)\/threads$/,
			({ params, body }) => {
				const parent = channelOf(state, params[0]);
				if (!parent.messages.some((message) => message.id === params[1]))
					throw unknownMessage();
				const name = str(body.name);
				if (!name) throw formError("name", "BASE_TYPE_REQUIRED", "required");
				const thread: EmuChannel = {
					id: newId(state),
					type: 11,
					name,
					...(parent.guildId ? { guildId: parent.guildId } : {}),
					parentId: parent.id,
					overwrites: [],
					messages: [],
					pins: [],
					renames: [],
					thread: {
						archived: false,
						locked: false,
						archiveTimestamp: Date.now(),
						autoArchiveDuration: Number(body.auto_archive_duration ?? 1440),
					},
				};
				state.channels.set(thread.id, thread);
				return channelJson(thread);
			},
		],
		[
			"GET",
			/^\/guilds\/(\d+)$/,
			({ params }) => {
				const guild = guildOf(params[0]);
				return { id: guild.id, owner_id: guild.ownerId };
			},
		],
		[
			"GET",
			/^\/guilds\/(\d+)\/channels$/,
			({ params }) => {
				const guild = guildOf(params[0]);
				return [...state.channels.values()]
					.filter((channel) => channel.guildId === guild.id && !channel.thread)
					.map(channelJson);
			},
		],
		[
			"POST",
			/^\/guilds\/(\d+)\/channels$/,
			({ params, body }) => {
				const guild = guildOf(params[0]);
				const name = str(body.name);
				if (!name) throw formError("name", "BASE_TYPE_REQUIRED", "required");
				const parentId = str(body.parent_id);
				const inGuild = [...state.channels.values()].filter(
					(channel) => channel.guildId === guild.id && !channel.thread,
				);
				if (inGuild.length >= state.guildLimit)
					throw new HttpError(
						400,
						30013,
						"Maximum number of server channels reached (500)",
					);
				if (parentId) {
					const parent = channelOf(state, parentId);
					if (parent.type !== 4)
						throw formError(
							"parent_id",
							"CHANNEL_PARENT_INVALID",
							"Not a category",
						);
					if (
						inGuild.filter((channel) => channel.parentId === parentId).length >=
						state.categoryLimit
					)
						throw formError(
							"parent_id",
							"CHANNEL_PARENT_MAX_CHANNELS",
							"Maximum number of channels in category reached (50)",
						);
				}
				const channel: EmuChannel = {
					id: newId(state),
					type: Number(body.type ?? 0),
					name,
					guildId: guild.id,
					...(parentId ? { parentId } : {}),
					...(str(body.topic) ? { topic: str(body.topic) } : {}),
					overwrites: [],
					messages: [],
					pins: [],
					renames: [],
				};
				state.channels.set(channel.id, channel);
				return channelJson(channel);
			},
		],
		[
			"GET",
			/^\/guilds\/(\d+)\/members\/(\d+)$/,
			({ params }) => {
				const member = guildOf(params[0]).members.get(params[1] ?? "");
				if (!member) throw new HttpError(404, 10007, "Unknown Member");
				return {
					nick: member.nick ?? null,
					roles: member.roles,
					user: {
						id: member.userId,
						username: member.username,
						global_name: member.globalName ?? null,
					},
				};
			},
		],
		[
			"GET",
			/^\/guilds\/(\d+)\/roles$/,
			({ params }) => guildOf(params[0]).roles,
		],
		[
			"GET",
			/^\/guilds\/(\d+)\/audit-logs$/,
			({ params, query }) => {
				const guild = guildOf(params[0]);
				if (!state.auditReadable) throw missingPermissions();
				const limit = Number(query.get("limit") ?? 50);
				// Newest first, only the thread updates asked for.
				const entries = [...(state.audit.get(guild.id) ?? [])]
					.reverse()
					.slice(0, limit)
					.map((entry) => ({
						id: entry.id,
						target_id: entry.targetId,
						user_id: entry.userId,
						action_type: Number(query.get("action_type") ?? 111),
						changes: entry.changes,
					}));
				return { audit_log_entries: entries };
			},
		],
	];
}
