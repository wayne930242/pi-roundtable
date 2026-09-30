import { type TObject, Type } from "typebox";
import Value from "typebox/value";
import { type Messages, messages } from "../i18n/index.ts";

/** What a call may do in one channel, with the owner-facing label; grants and permission checks name these. */
export const CHANNEL_OPERATIONS = [
	"read",
	"send",
	"edit",
	"pin",
	"delete",
	"channel",
	"permissions",
] as const;
export type ChannelOperation = (typeof CHANNEL_OPERATIONS)[number];

export const isChannelOperation = (value: string): value is ChannelOperation =>
	(CHANNEL_OPERATIONS as readonly string[]).includes(value);

const LABEL_KEYS = {
	read: "opRead",
	send: "opSend",
	edit: "opEdit",
	pin: "opPin",
	delete: "opDelete",
	channel: "opChannel",
	permissions: "opPermissions",
} as const satisfies Record<ChannelOperation, keyof Messages>;

/** The owner-facing label of an operation, in the active language. */
export const operationLabel = (operation: ChannelOperation): string =>
	messages()[LABEL_KEYS[operation]];

const id = Type.String({ pattern: "^\\d{1,20}$" });
const channel = { channelId: id };
const message = { channelId: id, messageId: id };
const strict = { additionalProperties: false } as const;

/** One upload may carry at most this much, in all files together. */
export const CHANNEL_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

const file = Type.Object(
	{
		filename: Type.String({
			minLength: 1,
			maxLength: 200,
			// No path separators or control characters.
			pattern: "^[^/\\\\\\u0000-\\u001f]+$",
			description: "The attachment file name, without a path",
		}),
		dataBase64: Type.String({
			minLength: 4,
			maxLength: Math.ceil(CHANNEL_UPLOAD_MAX_BYTES / 3) * 4,
			description:
				"The file content as standard base64, without a data URL prefix",
		}),
		description: Type.Optional(
			Type.String({ maxLength: 1024, description: "Alt text for an image" }),
		),
	},
	strict,
);
const files = Type.Optional(
	Type.Array(file, {
		minItems: 1,
		maxItems: 10,
		description:
			"Images or files to add; at most 8 MiB in total for the whole call",
	}),
);

interface ChannelTool {
	operation: ChannelOperation;
	schema: TObject;
	description: string;
}

/** The Discord tools a bundle can expose, each gated by one operation. */
export const CHANNEL_TOOLS: Record<string, ChannelTool> = {
	discord_get_channel_info: {
		operation: "read",
		schema: Type.Object(channel, strict),
		description: "Read the channel's server, name, and topic.",
	},
	discord_get_messages: {
		operation: "read",
		schema: Type.Object(
			{
				...channel,
				limit: Type.Optional(
					Type.Integer({ minimum: 1, maximum: 100, default: 20 }),
				),
				before: Type.Optional(id),
				after: Type.Optional(id),
				around: Type.Optional(id),
			},
			strict,
		),
		description:
			"Read the channel's recent messages; position with before, after, or around.",
	},
	discord_search_messages: {
		operation: "read",
		schema: Type.Object(
			{
				...channel,
				query: Type.Optional(
					Type.String({
						minLength: 1,
						maxLength: 1024,
						description:
							"Discord full-text search keywords; omit to browse by the other filters",
					}),
				),
				authorId: Type.Optional(id),
				afterDate: Type.Optional(
					Type.String({
						format: "date-time",
						description: "ISO 8601 start time, inclusive; needs a time zone",
					}),
				),
				beforeDate: Type.Optional(
					Type.String({
						format: "date-time",
						description: "ISO 8601 end time, exclusive; needs a time zone",
					}),
				),
				has: Type.Optional(
					Type.Union(
						["image", "sound", "video", "file", "link", "embed"].map((v) =>
							Type.Literal(v),
						),
					),
				),
				sort: Type.Optional(
					Type.Union(
						["newest", "oldest", "relevance"].map((v) => Type.Literal(v)),
						{ default: "newest" },
					),
				),
				limit: Type.Optional(
					Type.Integer({ minimum: 1, maximum: 25, default: 25 }),
				),
				offset: Type.Optional(
					Type.Integer({
						minimum: 0,
						maximum: 9975,
						default: 0,
						description:
							"For the next page keep the same filters and pass back nextOffset",
					}),
				),
			},
			strict,
		),
		description:
			"Search one channel's message history by keyword, author, date, attachment, and sort order. Page with nextOffset; the total is approximate, results are incomplete while indexing, and when limitReached narrow the date range.",
	},
	discord_get_pinned_messages: {
		operation: "read",
		schema: Type.Object(channel, strict),
		description: "Read the channel's pinned messages.",
	},
	discord_send_message: {
		operation: "send",
		schema: Type.Object(
			{
				...channel,
				content: Type.Optional(Type.String({ maxLength: 2000 })),
				files,
			},
			strict,
		),
		description:
			"Send a message, optionally with images or files; it triggers no @ mentions.",
	},
	discord_edit_message: {
		operation: "edit",
		schema: Type.Object(
			{
				...message,
				content: Type.Optional(Type.String({ maxLength: 2000 })),
				files,
				keepAttachmentIds: Type.Optional(
					Type.Array(id, {
						maxItems: 10,
						description:
							"Omit to keep every old attachment; an empty array removes them all; listed ids keep only those attachments",
					}),
				),
			},
			strict,
		),
		description: "Edit a message the bot itself sent.",
	},
	discord_delete_message: {
		operation: "delete",
		schema: Type.Object(message, strict),
		description: "Delete one message.",
	},
	discord_pin_message: {
		operation: "pin",
		schema: Type.Object(message, strict),
		description: "Pin one message.",
	},
	discord_unpin_message: {
		operation: "pin",
		schema: Type.Object(message, strict),
		description: "Unpin one message.",
	},
	discord_edit_channel: {
		operation: "channel",
		schema: Type.Object(
			{
				...channel,
				name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
				topic: Type.Optional(Type.String({ maxLength: 1024 })),
				nsfw: Type.Optional(Type.Boolean()),
				rateLimitPerUser: Type.Optional(
					Type.Integer({ minimum: 0, maximum: 21600 }),
				),
				position: Type.Optional(Type.Integer({ minimum: 0 })),
			},
			strict,
		),
		description:
			"Change the channel's name, topic, slowmode, and similar settings; it cannot move the category.",
	},
	discord_set_channel_permissions: {
		operation: "permissions",
		schema: Type.Object(
			{
				...channel,
				targetId: id,
				allow: Type.Optional(Type.Array(Type.String(), { maxItems: 60 })),
				deny: Type.Optional(Type.Array(Type.String(), { maxItems: 60 })),
			},
			strict,
		),
		description:
			"Set a role's or member's permission overwrite in this channel; permission names are discord.js PermissionFlagsBits.",
	},
	discord_delete_channel_permissions: {
		operation: "permissions",
		schema: Type.Object({ ...channel, targetId: id }, strict),
		description:
			"Remove a role's or member's permission overwrite in this channel.",
	},
};

/** A tool call that cannot be run as asked; the code is safe to show the caller. */
export class ChannelToolError extends Error {
	constructor(readonly code: string) {
		super(code);
	}
}

const DISCORD_EPOCH = 1420070400000;
const BASE64 =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Checks and fills defaults into a tool's arguments; throws ChannelToolError otherwise. */
export function parseChannelTool(
	tool: string,
	args: unknown,
): Record<string, unknown> {
	const spec = CHANNEL_TOOLS[tool];
	if (!spec) throw new ChannelToolError("INVALID_CHANNEL_OPERATION");
	const value = Value.Default(spec.schema, structuredClone(args ?? {}));
	if (!Value.Check(spec.schema, value))
		throw new ChannelToolError("INVALID_CHANNEL_ARGUMENTS");
	const parsed = value as Record<string, unknown>;
	if (tool === "discord_search_messages") {
		const after = parsed.afterDate && Date.parse(String(parsed.afterDate));
		const before = parsed.beforeDate && Date.parse(String(parsed.beforeDate));
		for (const date of [after, before]) {
			if (typeof date === "number" && date < DISCORD_EPOCH)
				throw new ChannelToolError("INVALID_CHANNEL_DATE_RANGE");
		}
		if (
			typeof after === "number" &&
			typeof before === "number" &&
			after >= before
		)
			throw new ChannelToolError("INVALID_CHANNEL_DATE_RANGE");
	}
	if (tool === "discord_send_message" || tool === "discord_edit_message") {
		const uploads = (parsed.files ?? []) as { dataBase64: string }[];
		if (
			tool === "discord_send_message" &&
			!parsed.content &&
			uploads.length === 0
		)
			throw new ChannelToolError("INVALID_CHANNEL_EMPTY_MESSAGE");
		if (
			tool === "discord_edit_message" &&
			parsed.content === undefined &&
			parsed.files === undefined &&
			parsed.keepAttachmentIds === undefined
		)
			throw new ChannelToolError("INVALID_CHANNEL_EMPTY_EDIT");
		let bytes = 0;
		for (const upload of uploads) {
			if (!BASE64.test(upload.dataBase64))
				throw new ChannelToolError("INVALID_CHANNEL_BASE64");
			const data = upload.dataBase64;
			bytes +=
				(data.length / 4) * 3 -
				(data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
			if (bytes > CHANNEL_UPLOAD_MAX_BYTES)
				throw new ChannelToolError("INVALID_CHANNEL_UPLOAD_SIZE");
		}
	}
	return parsed;
}

/** Runs Discord operations for granted calls; implemented over discord.js by the surface. */
export interface ChannelExecutor {
	/** The channel's guild, after checking the bot holds the operation's permissions. */
	inspect(
		channelId: string,
		operation: ChannelOperation,
	): Promise<{ guildId: string }>;
	execute(tool: string, args: Record<string, unknown>): Promise<unknown>;
	/** Current guild and channel names, or undefined when the bot cannot see the channel. */
	names(
		channelId: string,
	): Promise<{ guildName: string; channelName: string } | undefined>;
}
