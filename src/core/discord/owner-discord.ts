import {
	ChannelType,
	type Client,
	type Guild,
	PermissionFlagsBits,
} from "discord.js";
import { messages } from "../i18n/index.ts";
import type { OwnerOperations } from "../modules/discord-admin/discord-admin.ts";
import {
	discordChannelExecutor,
	fetchOwnerChannel,
	operationPermissions,
} from "./channel-executor.ts";
import { CHANNEL_TOOLS, parseChannelTool } from "./channel-operations.ts";
import {
	CHANNEL_TYPES,
	OwnerAccess,
	permissionFlags,
	permissionNames,
	refuse,
	roleOptions,
	SERVER_PERMISSIONS,
} from "./owner-discord-access.ts";
import { OwnerThreads } from "./owner-discord-threads.ts";

export { outranksMember, outranksRole } from "./owner-discord-access.ts";

/**
 * Discord operations for the owner's agent over the bot's connection. Every call is bounded
 * by what both the owner and the bot may do where it acts, read fresh from Discord.
 */
export class DiscordOwnerOps implements OwnerOperations {
	readonly #client: Client;
	readonly #ownerId: string;
	/** The audit-log reason of an action taken without one of its own. */
	readonly #reason: string;
	readonly #access: OwnerAccess;
	readonly #threadOps: OwnerThreads;

	constructor(client: Client, ownerId: string, ownerName = "the owner") {
		this.#client = client;
		this.#ownerId = ownerId;
		this.#reason = messages().auditRequested(ownerName);
		this.#access = new OwnerAccess(ownerId, ownerName);
		this.#threadOps = new OwnerThreads(
			client,
			this.#access,
			ownerId,
			this.#reason,
		);
	}

	async run(tool: string, args: Record<string, unknown>): Promise<unknown> {
		if (!this.#client.isReady())
			throw refuse("DISCORD_NOT_READY", "try again shortly");
		const channelTool = CHANNEL_TOOLS[tool];
		if (channelTool) {
			const parsed = parseChannelTool(tool, args);
			const channel = await fetchOwnerChannel(
				this.#client,
				String(parsed.channelId),
			);
			await this.#access.members(
				channel.guild,
				operationPermissions(channelTool.operation, channel),
				channel,
			);
			return discordChannelExecutor(this.#client, { threads: true }).execute(
				tool,
				parsed,
			);
		}
		if (tool === "discord_list_servers") return this.#servers();
		if (tool === "discord_delete_channel") return this.#deleteChannel(args);
		if (tool === "discord_create_thread") return this.#threadOps.create(args);
		if (tool === "discord_edit_thread") return this.#threadOps.edit(args);
		const needed = SERVER_PERMISSIONS[tool];
		if (!needed) throw refuse("INVALID_TOOL", tool);
		const guild = await this.#client.guilds
			.fetch(String(args.guildId))
			.catch(() => {
				throw refuse("UNKNOWN_SERVER", messages().refuseNotInServer);
			});
		return this.#serverTool(tool, guild, needed, args);
	}

	async #serverTool(
		tool: string,
		guild: Guild,
		needed: bigint[],
		args: Record<string, unknown>,
	): Promise<unknown> {
		const reason = typeof args.reason === "string" ? args.reason : this.#reason;
		if (tool === "discord_create_channel") {
			const parent = args.parentId
				? await this.#access.category(guild, String(args.parentId))
				: undefined;
			await this.#access.members(guild, needed, parent);
			const created = await guild.channels.create({
				name: String(args.name),
				type: CHANNEL_TYPES[args.type as keyof typeof CHANNEL_TYPES],
				...(parent ? { parent } : {}),
				...(typeof args.topic === "string" ? { topic: args.topic } : {}),
				reason,
			});
			return { id: created.id, name: created.name, parentId: created.parentId };
		}

		const { owner, bot } = await this.#access.members(guild, needed);
		switch (tool) {
			case "discord_list_channels": {
				const channels = await guild.channels.fetch();
				return [...channels.values()]
					.filter((c) => c !== null)
					.filter(
						(c) =>
							c.permissionsFor(owner).has(PermissionFlagsBits.ViewChannel) &&
							c.permissionsFor(bot).has(PermissionFlagsBits.ViewChannel),
					)
					.sort((a, b) => a.rawPosition - b.rawPosition)
					.map((c) => ({
						id: c.id,
						name: c.name,
						type: ChannelType[c.type],
						parentId: c.parentId,
						...("topic" in c && c.topic ? { topic: c.topic } : {}),
					}));
			}
			case "discord_list_threads":
				return this.#threadOps.list(guild, owner, bot, args);
			case "discord_list_roles": {
				const roles = await guild.roles.fetch();
				return [...roles.values()]
					.sort((a, b) => b.comparePositionTo(a))
					.map((role) => ({
						id: role.id,
						name: role.name,
						color: role.hexColor,
						managed: role.managed,
						hoist: role.hoist,
						mentionable: role.mentionable,
						permissions: role.permissions.toArray(),
					}));
			}
			case "discord_find_members": {
				const found = await guild.members.search({
					query: String(args.query),
					limit: typeof args.limit === "number" ? args.limit : 10,
				});
				return [...found.values()].map((m) => ({
					id: m.id,
					username: m.user.username,
					displayName: m.displayName,
					nickname: m.nickname,
					bot: m.user.bot,
					roles: [...m.roles.cache.values()].flatMap((r) =>
						r.id === guild.id ? [] : [r.name],
					),
				}));
			}
			case "discord_create_role": {
				const permissions = permissionFlags(args.permissions);
				this.#access.holdsAll(owner, permissions);
				const role = await guild.roles.create({
					...roleOptions(args, permissions),
					reason,
				});
				return { id: role.id, name: role.name };
			}
			case "discord_edit_role": {
				const role = await this.#access.role(guild, owner, args.roleId);
				const permissions =
					args.permissions === undefined
						? undefined
						: permissionFlags(args.permissions);
				if (permissions) this.#access.holdsAll(owner, permissions);
				await role.edit({ ...roleOptions(args, permissions), reason });
				return { id: role.id, name: role.name };
			}
			case "discord_delete_role": {
				const role = await this.#access.role(guild, owner, args.roleId);
				await role.delete(reason);
				return { id: role.id, deleted: true };
			}
			case "discord_add_member_role":
			case "discord_remove_member_role": {
				const role = await this.#access.role(guild, owner, args.roleId);
				const member = await this.#access.member(guild, args.userId);
				if (tool === "discord_add_member_role")
					await member.roles.add(role, reason);
				else await member.roles.remove(role, reason);
				return { userId: member.id, roleId: role.id };
			}
			case "discord_set_nickname": {
				const member = await this.#access.member(guild, args.userId);
				// The assistant's own nickname is the owner's to set wherever the owner may manage nicknames.
				if (member.id !== bot.id) this.#access.outranks(owner, member);
				const nickname = String(args.nickname).trim();
				await member.setNickname(nickname || null, reason);
				return { userId: member.id, nickname: nickname || null };
			}
			case "discord_timeout_member": {
				const member = await this.#access.member(guild, args.userId);
				this.#access.outranks(owner, member);
				const minutes = Number(args.minutes);
				await member.timeout(minutes > 0 ? minutes * 60_000 : null, reason);
				return { userId: member.id, minutes };
			}
			case "discord_kick_member": {
				const member = await this.#access.member(guild, args.userId);
				this.#access.outranks(owner, member);
				await member.kick(reason);
				return { userId: member.id, kicked: true };
			}
			case "discord_ban_member": {
				const userId = String(args.userId);
				// A user who already left can still be banned by id.
				const member = await guild.members
					.fetch({ user: userId, force: true })
					.catch(() => undefined);
				if (member) this.#access.outranks(owner, member);
				await guild.members.ban(userId, {
					deleteMessageSeconds:
						typeof args.deleteMessageSeconds === "number"
							? args.deleteMessageSeconds
							: 0,
					reason,
				});
				return { userId, banned: true };
			}
			case "discord_unban_member": {
				const userId = String(args.userId);
				await guild.members.unban(userId, reason);
				return { userId, banned: false };
			}
			default:
				throw refuse("INVALID_TOOL", tool);
		}
	}

	/** Servers the owner and the assistant share, with what each of them may do there. */
	async #servers() {
		const servers = [];
		for (const guild of this.#client.guilds.cache.values()) {
			const owner = await guild.members
				.fetch({ user: this.#ownerId })
				.catch(() => undefined);
			if (!owner) continue;
			const bot = await guild.members.fetchMe();
			servers.push({
				id: guild.id,
				name: guild.name,
				memberCount: guild.memberCount,
				ownerOwnsServer: guild.ownerId === this.#ownerId,
				assistantPermissions: permissionNames(bot),
				ownerPermissions: permissionNames(owner),
			});
		}
		return servers;
	}

	async #deleteChannel(args: Record<string, unknown>) {
		const channel = await this.#client.channels
			.fetch(String(args.channelId), { force: true })
			.catch(() => null);
		if (!channel || channel.isDMBased())
			throw refuse("INVALID_CHANNEL", messages().refuseNotVisible);
		await this.#access.members(
			channel.guild,
			[
				PermissionFlagsBits.ViewChannel,
				channel.isThread()
					? PermissionFlagsBits.ManageThreads
					: PermissionFlagsBits.ManageChannels,
			],
			channel,
		);
		await channel.delete(
			typeof args.reason === "string" ? args.reason : this.#reason,
		);
		return { id: channel.id, deleted: true };
	}
}
