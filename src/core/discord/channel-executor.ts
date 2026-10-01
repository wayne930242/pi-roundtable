import {
	type AnyThreadChannel,
	type APIMessage,
	ChannelType,
	type Client,
	type Message,
	type MessageCreateOptions,
	type MessageEditOptions,
	type NewsChannel,
	PermissionFlagsBits,
	type PermissionResolvable,
	type TextChannel,
} from "discord.js";
import { freeze } from "../freeze.ts";
import type { ChannelOperation } from "./channel-operations.ts";
import {
	type ChannelExecutor,
	ChannelToolError,
} from "./channel-operations.ts";

/** Discord permissions the bot (and the owner granting it) needs for each operation. */
export const OPERATION_PERMISSIONS: Readonly<
	Record<ChannelOperation, readonly bigint[]>
> = freeze({
	read: [
		PermissionFlagsBits.ViewChannel,
		PermissionFlagsBits.ReadMessageHistory,
	],
	send: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
	edit: [
		PermissionFlagsBits.ViewChannel,
		PermissionFlagsBits.ReadMessageHistory,
		PermissionFlagsBits.SendMessages,
	],
	pin: [
		PermissionFlagsBits.ViewChannel,
		PermissionFlagsBits.ReadMessageHistory,
		PermissionFlagsBits.PinMessages,
	],
	delete: [
		PermissionFlagsBits.ViewChannel,
		PermissionFlagsBits.ReadMessageHistory,
		PermissionFlagsBits.ManageMessages,
	],
	channel: [
		PermissionFlagsBits.ViewChannel,
		PermissionFlagsBits.ManageChannels,
	],
	permissions: [
		PermissionFlagsBits.ViewChannel,
		PermissionFlagsBits.ManageRoles,
	],
});

export type ManagedChannel = TextChannel | NewsChannel;
/** What the owner's own agent may also reach: threads of those channels. */
export type OwnerChannel = ManagedChannel | AnyThreadChannel;

/** A guild text or announcement channel, fetched fresh; anything else is refused. */
export async function fetchManagedChannel(
	client: Client,
	channelId: string,
): Promise<ManagedChannel> {
	const channel = await fetchOwnerChannel(client, channelId);
	if (channel.isThread()) throw new ChannelToolError("INVALID_CHANNEL");
	return channel;
}

/** A guild text or announcement channel or a thread, fetched fresh; anything else is refused. */
export async function fetchOwnerChannel(
	client: Client,
	channelId: string,
): Promise<OwnerChannel> {
	const channel = await client.channels
		.fetch(channelId, { force: true })
		.catch(() => null);
	if (
		!channel ||
		(channel.type !== ChannelType.GuildText &&
			channel.type !== ChannelType.GuildAnnouncement &&
			!channel.isThread())
	)
		throw new ChannelToolError("INVALID_CHANNEL");
	return channel;
}

/** The permissions an operation needs in a channel; posting in a thread has its own. */
export function operationPermissions(
	operation: ChannelOperation,
	channel: OwnerChannel,
): bigint[] {
	const needed = OPERATION_PERMISSIONS[operation];
	if (!channel.isThread()) return [...needed];
	return needed.map((flag) =>
		flag === PermissionFlagsBits.SendMessages
			? PermissionFlagsBits.SendMessagesInThreads
			: flag,
	);
}

interface ChannelFile {
	filename: string;
	dataBase64: string;
	description?: string;
}

function serializeMessage(message: Message) {
	return {
		id: message.id,
		channelId: message.channelId,
		authorId: message.author.id,
		content: message.content,
		createdAt: message.createdAt.toISOString(),
		editedAt: message.editedAt?.toISOString() ?? null,
		attachments: message.attachments.map((file) => ({
			id: file.id,
			filename: file.name,
			url: file.url,
			contentType: file.contentType,
			size: file.size,
			width: file.width,
			height: file.height,
			description: file.description,
		})),
		embeds: message.embeds.map((embed) => embed.toJSON()),
	};
}

function uploadOf(upload: ChannelFile) {
	return {
		attachment: Buffer.from(upload.dataBase64, "base64"),
		name: upload.filename,
		...(upload.description === undefined
			? {}
			: { description: upload.description }),
	};
}

function messagePayload(
	args: Record<string, unknown>,
): Pick<MessageCreateOptions, "content" | "allowedMentions" | "files"> {
	const uploads = args.files as ChannelFile[] | undefined;
	return {
		...(args.content !== undefined ? { content: String(args.content) } : {}),
		allowedMentions: { parse: [] },
		...(uploads ? { files: uploads.map(uploadOf) } : {}),
	};
}

function editPayload(
	message: Message,
	botId: string | undefined,
	args: Record<string, unknown>,
): MessageEditOptions {
	if (!botId || message.author.id !== botId)
		throw new ChannelToolError("INVALID_CHANNEL_MESSAGE_AUTHOR");
	const keep = args.keepAttachmentIds as string[] | undefined;
	if (
		keep?.some((id) => !message.attachments.has(id)) ||
		(keep && new Set(keep).size !== keep.length)
	)
		throw new ChannelToolError("INVALID_CHANNEL_ATTACHMENT_ID");
	const retained = keep ?? [...message.attachments.keys()];
	const added = (args.files as ChannelFile[] | undefined)?.length ?? 0;
	if (retained.length + added > 10)
		throw new ChannelToolError("INVALID_CHANNEL_ATTACHMENT_COUNT");
	return {
		...messagePayload(args),
		...(keep === undefined ? {} : { attachments: keep.map((id) => ({ id })) }),
	};
}

interface SearchResponse {
	code?: number;
	retry_after?: number;
	doing_deep_historical_index?: boolean;
	total_results?: number;
	messages?: APIMessage[][];
}

/** Snowflake bound for a date: the first ID Discord could assign at that time. */
const snowflakeAt = (date: string): bigint =>
	(BigInt(Date.parse(date)) - 1420070400000n) << 22n;

async function searchMessages(
	client: Client,
	channel: OwnerChannel,
	args: Record<string, unknown>,
) {
	const offset = Number(args.offset);
	const limit = Number(args.limit);
	const query = new URLSearchParams({
		channel_id: channel.id,
		limit: String(limit),
		offset: String(offset),
		sort_by: args.sort === "relevance" ? "relevance" : "timestamp",
		sort_order: args.sort === "oldest" ? "asc" : "desc",
		include_nsfw: String(
			channel.isThread() ? (channel.parent?.nsfw ?? false) : channel.nsfw,
		),
	});
	if (args.query !== undefined) query.set("content", String(args.query));
	if (args.authorId !== undefined)
		query.set("author_id", String(args.authorId));
	if (args.has !== undefined) query.set("has", String(args.has));
	if (args.afterDate !== undefined) {
		const bound = snowflakeAt(String(args.afterDate));
		query.set("min_id", (bound > 0n ? bound - 1n : bound).toString());
	}
	if (args.beforeDate !== undefined)
		query.set("max_id", snowflakeAt(String(args.beforeDate)).toString());
	const response = (await client.rest.get(
		`/guilds/${channel.guildId}/messages/search`,
		{ query },
	)) as SearchResponse;
	const base = { offset, limit, totalIsApproximate: true as const };
	if (response.code === 110000)
		return {
			status: "indexing",
			messages: [],
			indexing: true,
			retryAfterSeconds: Math.max(1, response.retry_after ?? 1),
			pagination: {
				...base,
				totalResults: null,
				hasMore: null,
				nextOffset: null,
				limitReached: false,
			},
		};
	const total = response.total_results;
	if (
		!Array.isArray(response.messages) ||
		typeof total !== "number" ||
		!Number.isInteger(total) ||
		total < 0
	)
		throw new Error("unexpected search response");
	const messages = response.messages.flat();
	// Never pass on another channel's messages, even if Discord's filter changes.
	if (messages.some((m) => m.channel_id !== channel.id))
		throw new Error("search returned another channel");
	const hasMore = offset + limit < total;
	const limitReached = hasMore && offset + limit > 9975;
	return {
		status: "ready",
		messages: messages.map((m) => ({
			id: m.id,
			channelId: m.channel_id,
			authorId: m.author.id,
			content: m.content,
			createdAt: m.timestamp,
			editedAt: m.edited_timestamp,
			attachments: m.attachments.map((f) => ({
				id: f.id,
				filename: f.filename,
				url: f.url,
				size: f.size,
				contentType: f.content_type ?? null,
				width: f.width ?? null,
				height: f.height ?? null,
				description: f.description ?? null,
			})),
			embeds: m.embeds,
		})),
		indexing: response.doing_deep_historical_index ?? false,
		retryAfterSeconds: null,
		pagination: {
			...base,
			totalResults: total,
			hasMore,
			nextOffset: hasMore && !limitReached ? offset + limit : null,
			limitReached,
		},
	};
}

async function editPermissions(
	channel: ManagedChannel,
	tool: string,
	args: Record<string, unknown>,
) {
	const targetId = String(args.targetId);
	if (tool === "discord_delete_channel_permissions") {
		await channel.permissionOverwrites.delete(targetId);
		return { channelId: channel.id, targetId };
	}
	const allow = (args.allow ?? []) as string[];
	const deny = (args.deny ?? []) as string[];
	for (const permission of [...allow, ...deny]) {
		if (!Object.hasOwn(PermissionFlagsBits, permission))
			throw new ChannelToolError("INVALID_PERMISSION");
	}
	// The bot cannot hand out a permission it does not hold itself.
	const bot = await channel.guild.members.fetchMe({ force: true });
	if (
		!channel
			.permissionsFor(bot)
			.has([...allow, ...deny] as PermissionResolvable[])
	)
		throw new ChannelToolError("BOT_PERMISSION_MISSING");
	await channel.permissionOverwrites.edit(
		targetId,
		Object.fromEntries([
			...allow.map((p) => [p, true]),
			...deny.map((p) => [p, false]),
		]),
	);
	return { channelId: channel.id, targetId };
}

/**
 * Channel operations over the bot's own Discord connection. Threads are reached only for the
 * owner's agent; outside agents' grants name text and announcement channels.
 */
export function discordChannelExecutor(
	client: Client,
	options: { threads?: boolean } = {},
): ChannelExecutor {
	const fetchChannel = (channelId: string): Promise<OwnerChannel> =>
		options.threads
			? fetchOwnerChannel(client, channelId)
			: fetchManagedChannel(client, channelId);
	return {
		async inspect(channelId, operation) {
			const channel = await fetchManagedChannel(client, channelId);
			const bot = await channel.guild.members.fetchMe({ force: true });
			if (!channel.permissionsFor(bot).has(OPERATION_PERMISSIONS[operation]))
				throw new ChannelToolError("BOT_PERMISSION_MISSING");
			return { guildId: channel.guildId };
		},

		async names(channelId) {
			try {
				const channel = await fetchManagedChannel(client, channelId);
				return { guildName: channel.guild.name, channelName: channel.name };
			} catch {
				return undefined;
			}
		},

		async execute(tool, args) {
			const channel = await fetchChannel(String(args.channelId));
			switch (tool) {
				case "discord_get_channel_info":
					return {
						id: channel.id,
						guildId: channel.guildId,
						guildName: channel.guild.name,
						name: channel.name,
						...(channel.isThread()
							? {
									thread: true,
									parentId: channel.parentId,
									archived: channel.archived,
									locked: channel.locked,
								}
							: { topic: channel.topic }),
					};
				case "discord_get_messages": {
					const messages = await channel.messages.fetch({
						limit: Number(args.limit),
						before: args.before as string | undefined,
						after: args.after as string | undefined,
						around: args.around as string | undefined,
					});
					return { messages: messages.map(serializeMessage) };
				}
				case "discord_search_messages":
					return searchMessages(client, channel, args);
				case "discord_get_pinned_messages": {
					const pinned = await channel.messages.fetchPins();
					return {
						messages: pinned.items.map((pin) => serializeMessage(pin.message)),
					};
				}
				case "discord_send_message":
					return serializeMessage(await channel.send(messagePayload(args)));
				case "discord_edit_channel": {
					if (channel.isThread())
						throw new ChannelToolError(
							"INVALID_CHANNEL: use discord_edit_thread",
						);
					const { channelId: _id, ...settings } = args;
					await channel.edit(settings);
					return { id: channel.id };
				}
				case "discord_set_channel_permissions":
				case "discord_delete_channel_permissions":
					if (channel.isThread())
						throw new ChannelToolError(
							"INVALID_CHANNEL: a thread takes its parent channel's permissions",
						);
					return editPermissions(channel, tool, args);
				default:
					// A message operation, handled below.
					break;
			}
			const message = await channel.messages.fetch(String(args.messageId));
			if (tool === "discord_edit_message")
				await message.edit(editPayload(message, client.user?.id, args));
			else if (tool === "discord_delete_message") await message.delete();
			else if (tool === "discord_pin_message") await message.pin();
			else if (tool === "discord_unpin_message") await message.unpin();
			else throw new ChannelToolError("INVALID_CHANNEL_OPERATION");
			return { id: message.id, channelId: channel.id };
		},
	};
}
