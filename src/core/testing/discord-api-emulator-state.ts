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
	/** The name a webhook post spoke under (`username`), when the request gave one. */
	username?: string;
	content: string;
	flags: number;
	/** Components the message carries; a v2 card has them without `content`. */
	components?: unknown;
	/** The embeds of a legacy message. */
	embeds?: unknown[];
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

/** A tag a forum offers, in Discord's wire form. */
export interface EmuTag {
	id: string;
	name: string;
	moderated: boolean;
	emoji_id: string | null;
	emoji_name: string | null;
}

export interface EmuChannel {
	id: string;
	/** 0 text, 1 direct, 4 category, 11 public thread, 15 forum. */
	type: number;
	guildId?: string;
	parentId?: string;
	name: string;
	topic?: string;
	overwrites: Record<string, unknown>[];
	messages: EmuMessage[];
	pins: { messageId: string; at: number }[];
	thread?: EmuThread;
	/** For a forum: the tags it offers. */
	tags?: EmuTag[];
	/** For a forum post: the ids of the tags applied to it. */
	appliedTags?: string[];
	/** The times of the renames Discord accepted. */
	renames: number[];
	recipientId?: string;
	/** The bot cannot view it (a private channel, a changed overwrite): Discord answers 50001 to a read. */
	hidden?: boolean;
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
	roles: EmuRole[];
}

/** A role; a role set up with only an id and permissions is at position 0 and unmanaged. */
export interface EmuRole {
	id: string;
	permissions: string;
	name?: string;
	position?: number;
	managed?: boolean;
}

/** A change of roles the audit log would show. */
export interface EmuRoleAudit {
	action: "add" | "remove" | "create";
	guildId: string;
	roleId: string;
	userId?: string;
	/** The `X-Audit-Log-Reason` header, decoded; null when the request had none. */
	reason: string | null;
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
	/** Every change of roles, in order. */
	roleAudit: EmuRoleAudit[];
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
export const missingAccess = () => new HttpError(403, 50001, "Missing Access");
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
		...(channel.type === 15 ? { available_tags: channel.tags ?? [] } : {}),
		...(channel.appliedTags ? { applied_tags: channel.appliedTags } : {}),
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
		embeds: message.embeds ?? [],
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

/** The most tags a forum holds, and the most applied to a post. */
const FORUM_TAGS = 20;
const POST_TAGS = 5;
/**
 * The tags a forum offers after a PATCH of `available_tags`: a tag with a known id is kept (and
 * may change), one without an id is made, and one left out is gone. The rules are our model of
 * Discord, from its documentation, not from what the real one was seen to answer.
 */
export function replaceTags(
	state: EmuState,
	forum: EmuChannel,
	given: unknown[],
): EmuTag[] {
	if (given.length > FORUM_TAGS)
		throw formError(
			"available_tags",
			"BASE_TYPE_MAX_LENGTH",
			`Must be ${FORUM_TAGS} or fewer in length.`,
		);
	const known = new Set((forum.tags ?? []).map((tag) => tag.id));
	return given.map((raw) => {
		const tag = object(raw);
		const name = str(tag.name);
		if (!name || [...name].length > 20)
			throw formError(
				"available_tags",
				"BASE_TYPE_BAD_LENGTH",
				"Must be between 1 and 20 in length.",
			);
		const id = str(tag.id);
		if (id && !known.has(id))
			throw formError("available_tags", "UNKNOWN_TAG", "Unknown tag");
		return {
			id: id ?? newId(state),
			name,
			moderated: tag.moderated === true,
			emoji_id: str(tag.emoji_id) ?? null,
			emoji_name: str(tag.emoji_name) ?? null,
		};
	});
}

/** The ids a post may carry: at most five, each one the forum offers. */
export function checkAppliedTags(
	forum: EmuChannel,
	given: unknown[],
): string[] {
	const ids = given.filter((id): id is string => typeof id === "string");
	if (ids.length > POST_TAGS)
		throw formError(
			"applied_tags",
			"BASE_TYPE_MAX_LENGTH",
			`Must be ${POST_TAGS} or fewer in length.`,
		);
	const offered = new Set((forum.tags ?? []).map((tag) => tag.id));
	if (ids.some((id) => !offered.has(id)))
		throw formError("applied_tags", "UNKNOWN_TAG", "Unknown tag");
	return ids;
}
