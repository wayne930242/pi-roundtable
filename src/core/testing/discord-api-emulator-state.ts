/** What the emulated Discord holds, and the small helpers its routes share. */

export const BOT_ID = "960000000000000009";
export const BOT_TOKEN = "test-bot-token";
export const DISCORD_EPOCH = 1_420_070_400_000n;
export const COMPONENTS_V2 = 1 << 15;

export interface EmuAttachment {
	id: string;
	filename: string;
	size: number;
	content_type: string;
	url: string;
}

export interface EmuMessage {
	id: string;
	channelId: string;
	authorId: string;
	webhookId?: string;
	content: string;
	flags: number;
	/** Components the message carries; a v2 card has them without `content`. */
	components?: unknown;
	attachments: EmuAttachment[];
	/** `allowed_mentions` as the request sent it: absent when it sent none. */
	allowedMentions?: { parse: string[]; users: string[] };
	type: number;
	referencedMessageId?: string;
}

export interface EmuThread {
	archived: boolean;
	locked: boolean;
	/** Epoch milliseconds. */
	archiveTimestamp: number;
	autoArchiveDuration: number;
}

export interface EmuChannel {
	id: string;
	/** 0 text, 1 direct, 4 category, 11 public thread. */
	type: number;
	guildId?: string;
	parentId?: string;
	name: string;
	topic?: string;
	overwrites: Record<string, unknown>[];
	messages: EmuMessage[];
	pins: { messageId: string; at: number }[];
	thread?: EmuThread;
	/** The times of the renames Discord accepted. */
	renames: number[];
	recipientId?: string;
}

export interface EmuWebhook {
	id: string;
	token: string;
	channelId: string;
	name: string;
	userId: string;
	avatar?: string;
}

export interface EmuMember {
	userId: string;
	nick?: string;
	globalName?: string;
	username: string;
	roles: string[];
}

export interface EmuGuild {
	id: string;
	ownerId: string;
	members: Map<string, EmuMember>;
	roles: { id: string; permissions: string }[];
}

export interface EmuAudit {
	id: string;
	targetId: string;
	userId: string;
	changes: { key: string; new_value: boolean }[];
}

/** Everything the emulated Discord holds. */
export interface EmuState {
	guilds: Map<string, EmuGuild>;
	channels: Map<string, EmuChannel>;
	webhooks: Map<string, EmuWebhook>;
	audit: Map<string, EmuAudit[]>;
	closedDirects: Set<string>;
	auditReadable: boolean;
	pinNotices: boolean;
	categoryLimit: number;
	guildLimit: number;
	/** The seconds a third rename is told to wait. */
	renameRetryAfter: number;
	next: bigint;
}

/** What a route answers: JSON, or nothing (204). */
export class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: number,
		message: string,
		readonly errors?: unknown,
		readonly headers?: Record<string, string>,
		readonly extra?: Record<string, unknown>,
	) {
		super(message);
	}
}

export const unknownChannel = () =>
	new HttpError(404, 10003, "Unknown Channel");
export const unknownMessage = () =>
	new HttpError(404, 10008, "Unknown Message");
export const missingPermissions = () =>
	new HttpError(403, 50013, "Missing Permissions");

/** A Discord snowflake for a moment, with a sequence number. */
export function snowflakeAt(ms: number, sequence = 0n): string {
	return (
		((BigInt(ms) - DISCORD_EPOCH) << 22n) +
		(sequence & 0x3fffffn)
	).toString();
}

/** An audit entry's id: a snowflake whose time is the moment of the change. */
export function auditId(state: EmuState, ms: number): string {
	state.next += 1n;
	return snowflakeAt(ms, state.next);
}

export function newId(state: EmuState): string {
	state.next += 1n;
	return state.next.toString();
}

export function channelJson(channel: EmuChannel) {
	return {
		id: channel.id,
		type: channel.type,
		name: channel.name,
		...(channel.guildId ? { guild_id: channel.guildId } : {}),
		...(channel.parentId ? { parent_id: channel.parentId } : {}),
		...(channel.topic ? { topic: channel.topic } : {}),
		permission_overwrites: channel.overwrites,
		...(channel.thread
			? {
					thread_metadata: {
						archived: channel.thread.archived,
						locked: channel.thread.locked,
						auto_archive_duration: channel.thread.autoArchiveDuration,
						archive_timestamp: new Date(
							channel.thread.archiveTimestamp,
						).toISOString(),
					},
				}
			: {}),
	};
}

export function messageJson(message: EmuMessage) {
	return {
		id: message.id,
		channel_id: message.channelId,
		type: message.type,
		content: message.content,
		flags: message.flags,
		author: { id: message.authorId },
		...(message.webhookId ? { webhook_id: message.webhookId } : {}),
		attachments: message.attachments,
		...(message.components ? { components: message.components } : {}),
		...(message.referencedMessageId
			? {
					message_reference: {
						message_id: message.referencedMessageId,
						channel_id: message.channelId,
					},
				}
			: {}),
	};
}

export function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function str(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

/** The `allowed_mentions` field of a request body, as it was sent. */
export function mentionsOf(body: Record<string, unknown>) {
	const sent = body.allowed_mentions;
	if (sent === undefined) return undefined;
	const given = object(sent);
	const list = (value: unknown) =>
		Array.isArray(value)
			? value.filter((entry): entry is string => typeof entry === "string")
			: [];
	return { parse: list(given.parse), users: list(given.users) };
}

/** A 400 for a form-body field, in Discord's shape. */
export function formError(field: string, code: string, message: string) {
	return new HttpError(400, 50035, "Invalid Form Body", {
		[field]: { _errors: [{ code, message }] },
	});
}
