import type { IdentityService } from "../identity/identity-service.ts";
import type { Logger } from "../log.ts";
import { type Tier, tierAtLeast } from "../speakers.ts";

/** A Discord user who pressed or ran something; their roles are unknown where the interaction carries no member. */
export interface DiscordUser {
	id: string;
	name: string;
	roleIds?: readonly string[];
}

/** What a Discord interaction tells of who made it; a test may give only `user.id`. */
export interface DiscordActor {
	user: { id: string; username?: string; globalName?: string | null };
	member?: unknown;
}

/** The user of an interaction, with their roles where its member carries them. */
export function discordUser(actor: DiscordActor): DiscordUser {
	const { user, member } = actor;
	const roles =
		typeof member === "object" && member !== null && "roles" in member
			? member.roles
			: undefined;
	const roleIds =
		typeof roles === "object" &&
		roles !== null &&
		"cache" in roles &&
		roles.cache instanceof Map
			? [...roles.cache.keys()].map(String)
			: undefined;
	return {
		id: user.id,
		name: user.globalName ?? user.username ?? user.id,
		...(roleIds ? { roleIds } : {}),
	};
}

export interface DiscordOwnersOptions {
	/** The primary owner's Discord user id, an owner whatever the identity service says. */
	ownerId: string;
	/** Who holds a tier and which owners have a Discord identity; without it the primary owner is the only owner. */
	identity?: Pick<IdentityService, "resolve" | "owners" | "identities">;
	logger: Logger;
}

/**
 * The owners as Discord knows them: the primary owner by their user id, and every other owner
 * principal's Discord identities, each checked again as they act. Only an owner's own identity is
 * ever resolved, so someone else's press or command admits no one.
 */
export class DiscordOwners {
	readonly #options: DiscordOwnersOptions;

	constructor(options: DiscordOwnersOptions) {
		this.#options = options;
	}

	/** The primary owner's Discord user id. */
	get primary(): string {
		return this.#options.ownerId;
	}

	/** The primary owner, then every other owner's Discord user ids. */
	async ids(): Promise<string[]> {
		const { ownerId, identity, logger } = this.#options;
		if (!identity) return [ownerId];
		const ids = new Set([ownerId]);
		try {
			for (const owner of await identity.owners())
				for (const link of await identity.identities(owner.id))
					if (link.provider === "discord") ids.add(link.subject);
		} catch (error) {
			logger.warn(
				{ err: error },
				"could not read the owners' identities; only the primary owner counts",
			);
		}
		return [...ids];
	}

	/** Whether the user is an owner now: the primary owner, or another owner's Discord identity at the owner tier. */
	async isOwner(user: DiscordUser): Promise<boolean> {
		if (user.id === this.#options.ownerId) return true;
		if (!(await this.ids()).includes(user.id)) return false;
		return this.holds(user, "owner");
	}

	/** Whether the principal is an owner's; false when it cannot be read. */
	async isOwnerPrincipal(principalId: string): Promise<boolean> {
		const { identity, logger } = this.#options;
		if (!identity) return false;
		try {
			const owners = await identity.owners();
			return owners.some((owner) => owner.id === principalId);
		} catch (error) {
			logger.warn(
				{ principal: principalId, err: error },
				"could not read the owners; the principal is not counted as one",
			);
			return false;
		}
	}

	/**
	 * Whether the user holds `minTier` as they act, as the principal named when there is one;
	 * without `minTier` anyone does. Call it only for someone already known, so it admits no one.
	 */
	async holds(
		user: DiscordUser,
		minTier: Tier | undefined,
		principalId?: string,
	): Promise<boolean> {
		const { identity } = this.#options;
		if (!minTier) return true;
		if (!identity) return false;
		const who = await identity.resolve({
			provider: "discord",
			subject: user.id,
			name: user.name,
			surface: "discord",
			...(user.roleIds
				? { roles: user.roleIds.map((role) => `discord:role:${role}`) }
				: {}),
			legacyId: user.id,
		});
		return (
			who !== undefined &&
			(principalId === undefined || who.principalId === principalId) &&
			tierAtLeast(who.tier, minTier)
		);
	}
}
