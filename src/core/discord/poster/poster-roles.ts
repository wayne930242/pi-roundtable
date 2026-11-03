import { checkSnowflake } from "./poster-checks.ts";
import { DiscordPosterError, invalid } from "./poster-errors.ts";

/** What the poster keeps of Discord's limits on roles and audit-log reasons. */
export const ROLE_LIMITS = Object.freeze({
	/** The longest name Discord gives a role. */
	nameChars: 100,
	/** The longest audit-log reason Discord keeps. */
	reasonChars: 512,
	/** The most roles one `addMemberRoles` or `removeMemberRoles` call takes. */
	perCall: 20,
} as const);

/** A role of a guild, as the poster reasons about whether it may be given. */
export interface GuildRole {
	id: string;
	name: string;
	/** Discord's order: a higher number sits higher, and @everyone is 0. */
	position: number;
	/** Made and kept by an integration or a bot, so it cannot be given by hand. */
	managed: boolean;
}

/**
 * The member and role calls of `DiscordPoster`. The poster only ever touches the roles a call
 * names: it adds or removes them one by one, and never sends a member's whole role list.
 */
export interface MemberRoles {
	/**
	 * The ids of the roles a member holds, as Discord lists them (the @everyone role is not among
	 * them); `undefined` for someone who is not a member of the guild.
	 */
	memberRoles(guildId: string, userId: string): Promise<string[] | undefined>;
	/**
	 * Gives a member these roles (Manage Roles), with `reason` in the guild's audit log (1 to 512
	 * characters, else `invalid`; so are no role, more than 20, or an id that is no Discord id). All
	 * are checked before any is given, and a role the member holds is left as it is. Refused, and
	 * nothing given, for a role the bot may not hand out: the @everyone role (`invalid`), a managed
	 * role, and one at or above the bot's highest role (`forbidden`, both with `role_unassignable`);
	 * a role the guild does not have is `rejected` with `unknown_role`, and a user who is not a
	 * member `rejected` with `not_member`.
	 *
	 * Not atomic: the checks run first, but a Discord failure after them (a 5xx, a timeout, a lost
	 * permission) may leave the earlier roles of the call changed; the error names the role that
	 * failed. Each change is idempotent, so retry the whole call and it converges.
	 */
	addMemberRoles(
		guildId: string,
		userId: string,
		roleIds: readonly string[],
		reason: string,
	): Promise<void>;
	/** Takes these roles from a member, under the same rules as `addMemberRoles`; a role the member lacks is left alone. */
	removeMemberRoles(
		guildId: string,
		userId: string,
		roleIds: readonly string[],
		reason: string,
	): Promise<void>;
	/**
	 * The id of the guild's role of that name (1 to 100 characters, exact match, not @everyone's
	 * or a managed role), made with no permissions and no colour when there is none (Manage Roles,
	 * `reason` in the audit log). A role that exists is never edited: its permissions, colour and
	 * position stay as they are. With several of the name, the oldest. Calls for the same name run
	 * one after another in this process, so two of them make one role; separate processes do not
	 * coordinate and may make two. A role that exists may sit at or above the bot's highest role (or
	 * be one the bot cannot hand out): it is returned all the same, and the next `addMemberRoles`
	 * refuses it with `role_unassignable`.
	 */
	ensureRole(guildId: string, name: string, reason: string): Promise<string>;
}

/** An audit-log reason: 1 to 512 characters. */
export function checkAuditReason(reason: string): string {
	const trimmed = reason.trim();
	if (trimmed === "") throw invalid("a role change needs an audit-log reason");
	if ([...trimmed].length > ROLE_LIMITS.reasonChars)
		throw invalid(
			`an audit-log reason is at most ${ROLE_LIMITS.reasonChars} characters`,
		);
	return trimmed;
}

/** A role's name: 1 to 100 characters, and not one that reads as a mention of everyone. */
export function checkRoleName(name: string): string {
	const trimmed = name.trim();
	if (trimmed === "" || [...trimmed].length > ROLE_LIMITS.nameChars)
		throw invalid(`a role name is 1 to ${ROLE_LIMITS.nameChars} characters`);
	if (/^@(everyone|here)$/i.test(trimmed))
		throw invalid("a role cannot be named @everyone or @here");
	return trimmed;
}

/** The roles a call names: at least one and at most 20, each a Discord id, each once. */
export function checkRoleIds(roleIds: readonly string[]): string[] {
	const wanted = [...new Set(roleIds)];
	if (wanted.length === 0) throw invalid("name at least one role");
	if (wanted.length > ROLE_LIMITS.perCall)
		throw invalid(`a call takes at most ${ROLE_LIMITS.perCall} roles`);
	return wanted.map((id) => checkSnowflake("a role", id));
}

/**
 * Refuses, before anything is sent, a role the bot may not give or take: the @everyone role, a
 * managed role, and a role at or above the bot's highest. The bot's own roles and the guild's
 * come from Discord, so the answer is the one Discord would give, in words that name the cause.
 */
export function refuseUnassignable(
	guildId: string,
	roles: readonly GuildRole[],
	botRoleIds: readonly string[],
	wanted: readonly string[],
): void {
	const byId = new Map(roles.map((role) => [role.id, role]));
	const top = Math.max(
		0,
		...botRoleIds.map((id) => byId.get(id)?.position ?? 0),
	);
	for (const id of wanted) {
		if (id === guildId)
			throw new DiscordPosterError(
				"invalid",
				"the @everyone role cannot be given or taken",
				{ reason: "role_unassignable" },
			);
		const role = byId.get(id);
		if (!role)
			throw new DiscordPosterError("rejected", `the guild has no role ${id}`, {
				reason: "unknown_role",
			});
		if (role.managed)
			throw new DiscordPosterError(
				"forbidden",
				`the role ${id} is managed by an integration and cannot be given by hand`,
				{ reason: "role_unassignable" },
			);
		if (role.position >= top)
			throw new DiscordPosterError(
				"forbidden",
				`the role ${id} is at or above the bot's highest role`,
				{ reason: "role_unassignable" },
			);
	}
}

/** The guild's role of that name that may be found by `ensureRole`: the oldest unmanaged one. */
export function roleNamed(
	guildId: string,
	roles: readonly GuildRole[],
	name: string,
): GuildRole | undefined {
	let found: GuildRole | undefined;
	for (const role of roles) {
		if (role.name !== name || role.managed || role.id === guildId) continue;
		if (!found || BigInt(role.id) < BigInt(found.id)) found = role;
	}
	return found;
}

/** What `addMemberRoles` and `removeMemberRoles` throw for a user who is not in the guild. */
export function notMember(): DiscordPosterError {
	return new DiscordPosterError(
		"rejected",
		"that user is not a member of the guild",
		{ reason: "not_member", discordCode: 10007, status: 404 },
	);
}
