import {
	ChannelType,
	type Guild,
	type GuildBasedChannel,
	type GuildMember,
	PermissionFlagsBits,
	PermissionsBitField,
	type Role,
} from "discord.js";
import { messages } from "../i18n/index.ts";
import { ChannelToolError } from "./channel-operations.ts";

/** What both the owner and the bot hold in the server for each server-level tool. */
export const SERVER_PERMISSIONS: Record<string, bigint[]> = {
	discord_list_channels: [],
	discord_list_roles: [],
	discord_list_threads: [],
	discord_find_members: [],
	discord_create_channel: [PermissionFlagsBits.ManageChannels],
	discord_create_role: [PermissionFlagsBits.ManageRoles],
	discord_edit_role: [PermissionFlagsBits.ManageRoles],
	discord_delete_role: [PermissionFlagsBits.ManageRoles],
	discord_add_member_role: [PermissionFlagsBits.ManageRoles],
	discord_remove_member_role: [PermissionFlagsBits.ManageRoles],
	discord_set_nickname: [PermissionFlagsBits.ManageNicknames],
	discord_timeout_member: [PermissionFlagsBits.ModerateMembers],
	discord_kick_member: [PermissionFlagsBits.KickMembers],
	discord_ban_member: [PermissionFlagsBits.BanMembers],
	discord_unban_member: [PermissionFlagsBits.BanMembers],
};

export const CHANNEL_TYPES = {
	text: ChannelType.GuildText,
	voice: ChannelType.GuildVoice,
	announcement: ChannelType.GuildAnnouncement,
	category: ChannelType.GuildCategory,
} as const;

export const refuse = (code: string, detail: string) =>
	new ChannelToolError(`${code}: ${detail}`);

/** The owner outranks a role when the owner's highest role is above it, or the owner owns the server. */
export function outranksRole(owner: GuildMember, role: Role): boolean {
	return (
		owner.guild.ownerId === owner.id ||
		owner.roles.highest.comparePositionTo(role) > 0
	);
}

export function outranksMember(
	owner: GuildMember,
	target: GuildMember,
): boolean {
	if (owner.guild.ownerId === owner.id) return target.id !== owner.id;
	return (
		target.id !== owner.guild.ownerId &&
		owner.roles.highest.comparePositionTo(target.roles.highest) > 0
	);
}

export function permissionFlags(names: unknown): bigint[] {
	const list = (names ?? []) as string[];
	for (const name of list) {
		if (!Object.hasOwn(PermissionFlagsBits, name))
			throw refuse("INVALID_PERMISSION", name);
	}
	return list.map(
		(name) => PermissionFlagsBits[name as keyof typeof PermissionFlagsBits],
	);
}

/** The owner's and the bot's standing in a server: who holds what, and who outranks whom. */
export class OwnerAccess {
	readonly #ownerId: string;
	readonly #ownerName: string;

	constructor(ownerId: string, ownerName: string) {
		this.#ownerId = ownerId;
		this.#ownerName = ownerName;
	}

	/**
	 * The owner's and the bot's members, after checking both hold the permissions, in the
	 * channel when one is given and in the server otherwise.
	 */
	async members(
		guild: Guild,
		needed: bigint[],
		channel?: GuildBasedChannel,
	): Promise<{ owner: GuildMember; bot: GuildMember }> {
		const owner = await guild.members
			.fetch({ user: this.#ownerId, force: true })
			.catch(() => undefined);
		if (!owner)
			throw refuse(
				"OWNER_NOT_IN_SERVER",
				`${this.#ownerName} is not in that server`,
			);
		const bot = await guild.members.fetchMe({ force: true });
		const has = (member: GuildMember) =>
			(channel ? channel.permissionsFor(member) : member.permissions).has(
				needed,
			);
		const names = new PermissionsBitField(needed).toArray().join(", ");
		if (!has(owner))
			throw refuse(
				"OWNER_PERMISSION_MISSING",
				`${this.#ownerName} lacks ${names} there`,
			);
		if (!has(bot))
			throw refuse(
				"BOT_PERMISSION_MISSING",
				messages().refuseAssistantLacks(names),
			);
		return { owner, bot };
	}

	holdsAll(owner: GuildMember, permissions: bigint[]): void {
		if (!owner.permissions.has(permissions))
			throw refuse(
				"OWNER_PERMISSION_MISSING",
				`${this.#ownerName} does not hold every permission the role would grant`,
			);
	}

	outranks(owner: GuildMember, member: GuildMember): void {
		if (!outranksMember(owner, member))
			throw refuse(
				"HIERARCHY",
				`that member is not below ${this.#ownerName}'s highest role`,
			);
	}

	async role(guild: Guild, owner: GuildMember, roleId: unknown) {
		const role = await guild.roles.fetch(String(roleId)).catch(() => null);
		if (!role) throw refuse("UNKNOWN_ROLE", String(roleId));
		if (!outranksRole(owner, role))
			throw refuse(
				"HIERARCHY",
				`that role is not below ${this.#ownerName}'s highest role`,
			);
		return role;
	}

	async member(guild: Guild, userId: unknown) {
		const member = await guild.members
			.fetch({ user: String(userId), force: true })
			.catch(() => undefined);
		if (!member) throw refuse("UNKNOWN_MEMBER", String(userId));
		return member;
	}

	async category(guild: Guild, parentId: string) {
		const parent = await guild.channels.fetch(parentId).catch(() => null);
		if (parent?.type !== ChannelType.GuildCategory)
			throw refuse("INVALID_CHANNEL", "parentId is not a category there");
		return parent;
	}
}

/** A member's server permissions; an administrator holds them all. */
export function permissionNames(member: GuildMember): string[] {
	return member.permissions.has(PermissionFlagsBits.Administrator)
		? ["Administrator"]
		: member.permissions.toArray();
}

export function roleOptions(
	args: Record<string, unknown>,
	permissions: bigint[] | undefined,
) {
	return {
		...(typeof args.name === "string" ? { name: args.name } : {}),
		...(typeof args.color === "string"
			? { colors: { primaryColor: args.color as `#${string}` } }
			: {}),
		...(typeof args.hoist === "boolean" ? { hoist: args.hoist } : {}),
		...(typeof args.mentionable === "boolean"
			? { mentionable: args.mentionable }
			: {}),
		...(permissions ? { permissions } : {}),
	};
}
