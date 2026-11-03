import { checkSnowflake } from "../discord/poster/poster-checks.ts";
import { DiscordPosterError } from "../discord/poster/poster-errors.ts";
import {
	checkAuditReason,
	checkRoleIds,
	checkRoleName,
	type GuildRole,
	notMember,
	refuseUnassignable,
	roleNamed,
} from "../discord/poster/poster-roles.ts";
import { FakePosterReads } from "./fake-poster-reads.ts";

/** One change of a role or of a member's roles, as the fake's audit log holds it. */
export interface FakeRoleChange {
	action: "add" | "remove" | "create";
	guildId: string;
	roleId: string;
	/** The member, for an `add` or a `remove`. */
	userId?: string;
	reason: string;
}

/** The fake's member and role calls, on top of its channel, thread, forum and read calls. */
export abstract class FakePosterRoles extends FakePosterReads {
	/** The guild's roles by id, @everyone's left out; `ensureRole` makes more. A test sets them up here. */
	readonly roles = new Map<string, GuildRole>();
	/** The ids of the roles the bot holds; the bot may give only roles below its highest. */
	botRoles: string[] = [];
	/**
	 * The ids of the roles each member holds, by user id. A user is a member when `memberNames`
	 * or this map lists them (and `nonMembers` does not).
	 */
	readonly memberRoleIds = new Map<string, string[]>();
	/** Every change of roles, in order, with its audit-log reason. */
	readonly roleChanges: FakeRoleChange[] = [];
	protected nextRole = 5_000_000_000_000_000_000n;

	protected constructor(idOffset: bigint, now: () => number) {
		super(idOffset, now);
		this.nextRole += idOffset;
	}

	#held(guildId: string, userId: string): string[] | undefined {
		if (guildId !== this.guildId || this.nonMembers.has(userId))
			return undefined;
		const held = this.memberRoleIds.get(userId);
		if (!(held || this.memberNames.has(userId))) return undefined;
		return [...(held ?? [])];
	}

	async memberRoles(
		guildId: string,
		userId: string,
	): Promise<string[] | undefined> {
		checkSnowflake("a guild", guildId);
		checkSnowflake("a user", userId);
		this.sent("memberRoles");
		return this.#held(guildId, userId);
	}

	async addMemberRoles(
		guildId: string,
		userId: string,
		roleIds: readonly string[],
		reason: string,
	): Promise<void> {
		this.#change("add", guildId, userId, roleIds, reason);
	}

	async removeMemberRoles(
		guildId: string,
		userId: string,
		roleIds: readonly string[],
		reason: string,
	): Promise<void> {
		this.#change("remove", guildId, userId, roleIds, reason);
	}

	#change(
		action: "add" | "remove",
		guildId: string,
		userId: string,
		roleIds: readonly string[],
		reason: string,
	): void {
		checkSnowflake("a guild", guildId);
		checkSnowflake("a user", userId);
		const wanted = checkRoleIds(roleIds);
		const why = checkAuditReason(reason);
		this.sent(action === "add" ? "addMemberRoles" : "removeMemberRoles");
		if (guildId !== this.guildId)
			throw new DiscordPosterError(
				"forbidden",
				"the bot is not a member of that guild",
			);
		refuseUnassignable(guildId, [...this.roles.values()], this.botRoles, wanted);
		const held = this.#held(guildId, userId);
		if (!held) throw notMember();
		let next = held;
		for (const roleId of wanted) {
			next =
				action === "add"
					? next.includes(roleId)
						? next
						: [...next, roleId]
					: next.filter((id) => id !== roleId);
			this.roleChanges.push({
				action,
				guildId,
				roleId,
				userId,
				reason: why,
			});
		}
		this.memberRoleIds.set(userId, next);
	}

	async ensureRole(
		guildId: string,
		name: string,
		reason: string,
	): Promise<string> {
		checkSnowflake("a guild", guildId);
		const wanted = checkRoleName(name);
		const why = checkAuditReason(reason);
		this.sent("ensureRole");
		if (guildId !== this.guildId)
			throw new DiscordPosterError(
				"forbidden",
				"the bot is not a member of that guild",
			);
		const found = roleNamed(guildId, [...this.roles.values()], wanted);
		if (found) return found.id;
		// Discord puts a new role just above @everyone and moves the others up.
		for (const [id, role] of this.roles)
			if (role.position >= 1)
				this.roles.set(id, { ...role, position: role.position + 1 });
		this.nextRole += 1n;
		const id = this.nextRole.toString();
		this.roles.set(id, { id, name: wanted, position: 1, managed: false });
		this.roleChanges.push({
			action: "create",
			guildId,
			roleId: id,
			reason: why,
		});
		return id;
	}
}
