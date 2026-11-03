import { RESTJSONErrorCodes, Routes } from "discord.js";
import { checkSnowflake } from "./poster-checks.ts";
import { DiscordPosterError, failure, isCode } from "./poster-errors.ts";
import {
	checkAuditReason,
	checkRoleIds,
	checkRoleName,
	type GuildRole,
	type MemberRoles,
	notMember,
	refuseUnassignable,
	roleNamed,
} from "./poster-roles.ts";
import { object, type RestCore, text } from "./rest-poster-core.ts";

/** The poster's member and role calls. */
export function roleOperations(core: RestCore): MemberRoles {
	const { rest } = core;

	const guildRoles = async (guildId: string): Promise<GuildRole[]> => {
		const listed = await rest
			.get(Routes.guildRoles(guildId))
			.catch((error: unknown) => {
				throw failure("listing the guild's roles", error);
			});
		return (Array.isArray(listed) ? listed : []).flatMap((entry) => {
			const role = object(entry);
			const id = text(role.id);
			return id
				? [
						{
							id,
							name: text(role.name) ?? "",
							position: typeof role.position === "number" ? role.position : 0,
							managed: role.managed === true,
						},
					]
				: [];
		});
	};

	/** The ids of a member's roles; undefined for someone who is not in the guild. */
	const rolesOf = async (
		guildId: string,
		userId: string,
	): Promise<string[] | undefined> => {
		let member: Record<string, unknown>;
		try {
			member = object(await rest.get(Routes.guildMember(guildId, userId)));
		} catch (error) {
			if (isCode(error, RESTJSONErrorCodes.UnknownMember)) return undefined;
			throw failure("reading a guild member", error);
		}
		return Array.isArray(member.roles)
			? member.roles.filter((id): id is string => typeof id === "string")
			: [];
	};

	const change = async (
		verb: "add" | "remove",
		guildId: string,
		userId: string,
		roleIds: readonly string[],
		reason: string,
	): Promise<void> => {
		checkSnowflake("a guild", guildId);
		checkSnowflake("a user", userId);
		const wanted = checkRoleIds(roleIds);
		const why = checkAuditReason(reason);
		// Everything is checked before the first role is given, so a refusal gives none.
		const botRoles = await rolesOf(guildId, await core.bot());
		if (!botRoles)
			throw new DiscordPosterError(
				"forbidden",
				"the bot is not a member of that guild",
			);
		refuseUnassignable(guildId, await guildRoles(guildId), botRoles, wanted);
		for (const roleId of wanted) {
			const route = Routes.guildMemberRole(guildId, userId, roleId);
			try {
				if (verb === "add") await rest.put(route, { reason: why });
				else await rest.delete(route, { reason: why });
			} catch (error) {
				if (isCode(error, RESTJSONErrorCodes.UnknownMember))
					throw notMember();
				throw failure(
					verb === "add"
						? "giving a member a role"
						: "taking a role from a member",
					error,
				);
			}
		}
	};

	const making = new Map<string, Promise<string>>();
	const ensure = async (
		guildId: string,
		name: string,
		reason: string,
	): Promise<string> => {
		const found = roleNamed(guildId, await guildRoles(guildId), name);
		if (found) return found.id;
		// No permissions, no colour, not shown apart and not pingable: a marker, nothing more.
		const made = object(
			await rest
				.post(Routes.guildRoles(guildId), {
					body: {
						name,
						permissions: "0",
						hoist: false,
						mentionable: false,
					},
					reason,
				})
				.catch((error: unknown) => {
					throw failure("making a role", error);
				}),
		);
		const id = text(made.id);
		if (!id) throw new DiscordPosterError("rejected", "Discord made no role");
		return id;
	};

	return {
		async memberRoles(guildId, userId) {
			checkSnowflake("a guild", guildId);
			checkSnowflake("a user", userId);
			return rolesOf(guildId, userId);
		},
		addMemberRoles: (guildId, userId, roleIds, reason) =>
			change("add", guildId, userId, roleIds, reason),
		removeMemberRoles: (guildId, userId, roleIds, reason) =>
			change("remove", guildId, userId, roleIds, reason),
		async ensureRole(guildId, name, reason) {
			checkSnowflake("a guild", guildId);
			const wanted = checkRoleName(name);
			const why = checkAuditReason(reason);
			const slot = `${guildId}:${wanted}`;
			let pending = making.get(slot);
			if (!pending) {
				pending = ensure(guildId, wanted, why).finally(() =>
					making.delete(slot),
				);
				making.set(slot, pending);
			}
			return pending;
		},
	};
}
