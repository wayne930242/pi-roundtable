import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type TObject, Type } from "typebox";
import {
	CHANNEL_TOOLS,
	ChannelToolError,
} from "../../discord/channel-operations.ts";
import { assistantName } from "../../i18n/index.ts";
import {
	type OwnerIdentity,
	type OwnerWords,
	ownerWords,
} from "../../identity.ts";
import { textToolsExtension } from "../../runtime/text-tools.ts";

const id = Type.String({ pattern: "^\\d{1,20}$" });
const guild = { guildId: id };
const member = { guildId: id, userId: id };
const reason = Type.Optional(
	Type.String({
		maxLength: 400,
		description: "Shown in the server's audit log.",
	}),
);
const roleFields = {
	name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
	color: Type.Optional(
		Type.String({ pattern: "^#[0-9a-fA-F]{6}$", description: "#rrggbb" }),
	),
	hoist: Type.Optional(
		Type.Boolean({ description: "Show members separately in the list." }),
	),
	mentionable: Type.Optional(Type.Boolean()),
	permissions: Type.Optional(
		Type.Array(Type.String(), {
			maxItems: 60,
			description:
				"Every permission the role grants, as discord.js PermissionFlagsBits names.",
		}),
	),
};
const strict = { additionalProperties: false } as const;
const autoArchive = Type.Union(
	[60, 1440, 4320, 10080].map((v) => Type.Literal(v)),
	{
		description: "Minutes of inactivity before the thread archives.",
	},
);

interface ServerTool {
	label: string;
	/** The tool's description, naming the owner in `o`'s words. */
	describe(o: OwnerWords): string;
	parameters: TObject;
}

/** Server-level tools only the owner's agent has; channel tools reuse the outside-agent set. */
export const SERVER_TOOLS: Record<string, ServerTool> = {
	discord_list_servers: {
		label: "List Discord servers",
		describe: (o) =>
			`List the Discord servers that ${o.name} and ${assistantName()} share, with the server permissions each of them holds there.`,
		parameters: Type.Object({}, strict),
	},
	discord_list_channels: {
		label: "List channels",
		describe: (o) =>
			`List a server's channels and categories that both ${o.name} and ${assistantName()} can see.`,
		parameters: Type.Object(guild, strict),
	},
	discord_list_roles: {
		label: "List roles",
		describe: () =>
			"List a server's roles, highest first, with their permissions.",
		parameters: Type.Object(guild, strict),
	},
	discord_find_members: {
		label: "Find members",
		describe: () =>
			"Find server members whose username or server nickname starts with the query.",
		parameters: Type.Object(
			{
				...guild,
				query: Type.String({ minLength: 1, maxLength: 100 }),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
			},
			strict,
		),
	},
	discord_create_channel: {
		label: "Create channel",
		describe: () =>
			"Create a text, voice, or announcement channel, or a category.",
		parameters: Type.Object(
			{
				...guild,
				name: Type.String({ minLength: 1, maxLength: 100 }),
				type: Type.Union(
					["text", "voice", "announcement", "category"].map((v) =>
						Type.Literal(v),
					),
				),
				parentId: Type.Optional(id),
				topic: Type.Optional(Type.String({ maxLength: 1024 })),
				reason,
			},
			strict,
		),
	},
	discord_delete_channel: {
		label: "Delete channel",
		describe: () => "Delete a channel, category, or thread.",
		parameters: Type.Object({ channelId: id, reason }, strict),
	},
	discord_list_threads: {
		label: "List threads",
		describe: (o) =>
			`List a server's active threads that both ${o.name} and ${assistantName()} can see, optionally only those under one channel; with archived, list that channel's archived threads instead. The message tools take a thread's id as channelId.`,
		parameters: Type.Object(
			{
				...guild,
				parentId: Type.Optional(id),
				archived: Type.Optional(
					Type.Boolean({ description: "Needs parentId." }),
				),
			},
			strict,
		),
	},
	discord_create_thread: {
		label: "Start thread",
		describe: (o) =>
			`Start a thread in a text or announcement channel, from one of its messages or on its own. A private thread (text channels only, not from a message) gets ${o.name} added. Post in it with discord_send_message using the thread's id.`,
		parameters: Type.Object(
			{
				channelId: id,
				name: Type.String({ minLength: 1, maxLength: 100 }),
				messageId: Type.Optional(id),
				private: Type.Optional(Type.Boolean()),
				autoArchiveMinutes: Type.Optional(autoArchive),
				reason,
			},
			strict,
		),
	},
	discord_edit_thread: {
		label: "Edit thread",
		describe: () =>
			"Rename a thread, archive or unarchive it, lock or unlock it, or change when it auto-archives.",
		parameters: Type.Object(
			{
				threadId: id,
				name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
				archived: Type.Optional(Type.Boolean()),
				locked: Type.Optional(
					Type.Boolean({
						description: "Only members who can manage threads may post.",
					}),
				),
				autoArchiveMinutes: Type.Optional(autoArchive),
				reason,
			},
			strict,
		),
	},
	discord_create_role: {
		label: "Create role",
		describe: () => "Create a role.",
		parameters: Type.Object(
			{
				...guild,
				...roleFields,
				name: Type.String({ minLength: 1, maxLength: 100 }),
				reason,
			},
			strict,
		),
	},
	discord_edit_role: {
		label: "Edit role",
		describe: () =>
			"Change a role's name, color, display, or permissions; permissions replaces the whole set.",
		parameters: Type.Object(
			{ ...guild, roleId: id, ...roleFields, reason },
			strict,
		),
	},
	discord_delete_role: {
		label: "Delete role",
		describe: () => "Delete a role.",
		parameters: Type.Object({ ...guild, roleId: id, reason }, strict),
	},
	discord_add_member_role: {
		label: "Give role",
		describe: () => "Give a member a role.",
		parameters: Type.Object({ ...member, roleId: id, reason }, strict),
	},
	discord_remove_member_role: {
		label: "Take role",
		describe: () => "Take a role from a member.",
		parameters: Type.Object({ ...member, roleId: id, reason }, strict),
	},
	discord_set_nickname: {
		label: "Set nickname",
		describe: () =>
			`Set a member's server nickname; an empty nickname clears it. ${assistantName()}'s own id changes its name in that server.`,
		parameters: Type.Object(
			{ ...member, nickname: Type.String({ maxLength: 32 }), reason },
			strict,
		),
	},
	discord_timeout_member: {
		label: "Time out member",
		describe: () =>
			"Stop a member from talking for some minutes; 0 lifts a timeout.",
		parameters: Type.Object(
			{
				...member,
				minutes: Type.Integer({ minimum: 0, maximum: 40320 }),
				reason,
			},
			strict,
		),
	},
	discord_kick_member: {
		label: "Kick member",
		describe: () => "Remove a member from the server; they can join again.",
		parameters: Type.Object({ ...member, reason }, strict),
	},
	discord_ban_member: {
		label: "Ban member",
		describe: () =>
			"Ban a user from the server, optionally deleting their recent messages.",
		parameters: Type.Object(
			{
				...member,
				deleteMessageSeconds: Type.Optional(
					Type.Integer({ minimum: 0, maximum: 604800 }),
				),
				reason,
			},
			strict,
		),
	},
	discord_unban_member: {
		label: "Unban member",
		describe: () => "Lift a user's ban.",
		parameters: Type.Object({ ...member, reason }, strict),
	},
};

/** Every Discord tool of the owner's `discord` profile. */
export const DISCORD_OWNER_TOOLS = [
	...Object.keys(CHANNEL_TOOLS),
	...Object.keys(SERVER_TOOLS),
];

/** Runs one Discord tool for the owner; throws ChannelToolError for a refused call. */
export interface OwnerDiscord {
	run(tool: string, args: Record<string, unknown>): Promise<unknown>;
}

export function discordAdminExtension(
	discord: OwnerDiscord,
	owner: OwnerIdentity,
): ExtensionFactory {
	const o = ownerWords(owner);
	const specs = [
		...Object.entries(CHANNEL_TOOLS).map(([name, spec]) => ({
			name,
			label: name,
			description: spec.description,
			parameters: spec.schema,
		})),
		...Object.entries(SERVER_TOOLS).map(([name, spec]) => ({
			name,
			label: spec.label,
			description: spec.describe(o),
			parameters: spec.parameters,
		})),
	];
	return textToolsExtension(
		specs.map((spec) => ({
			...spec,
			run: async (input) => JSON.stringify(await discord.run(spec.name, input)),
		})),
		ChannelToolError,
	);
}
