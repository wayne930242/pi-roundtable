import { ConfigError, IdentityError } from "../domain/errors.ts";
import { freeze } from "../freeze.ts";
import type { Logger } from "../log.ts";
import type { ChannelKey } from "../sessions.ts";
import { type Speaker, type Tier, tierAtLeast } from "../speakers.ts";
import {
	type AccessRules,
	checkAccessRules,
	factsTier,
} from "./access-policy.ts";
import { type ActorFacts, identityOf, parseIdentity } from "./actor-facts.ts";
import { CachingPrincipalStore } from "./caching-principal-store.ts";
import {
	type IdentityLink,
	type Principal,
	type PrincipalRecord,
	type PrincipalStore,
	type RoleGrant,
	SYSTEM_PRINCIPAL,
} from "./principal-store.ts";
import { isPrincipalId } from "./ulid.ts";

/**
 * Who the host serves: its principals, their identities, and their roles, read-only. Provided as
 * `IDENTITY` by the `identity` plugin; the principals are written by the host's own configuration
 * and the `roundtable principal` CLI, never through it. A change another process makes is seen
 * within half a minute.
 */
export interface IdentityService {
	/**
	 * The speaker behind these facts, or undefined when the access rules serve no one by them: a
	 * linked identity is its principal's; an unlinked one first claims the principal of its 0.8
	 * id (`legacyId`) when the backfill made it and no identity was ever linked to it, unless it
	 * holds the owner role, and is otherwise admitted as a new principal when the rules give it a
	 * tier. Both happen only when `provisioning` is `admitted`; under `linked` only identities
	 * already linked are served. A disabled principal is no one. The tier is the higher of the
	 * principal's lasting roles and what the rules give the facts on this contact.
	 */
	resolve(
		facts: ActorFacts,
		scope?: { conversation?: ChannelKey },
	): Promise<Speaker | undefined>;
	principal(id: string): Promise<Principal | undefined>;
	/** Every principal, the oldest first. */
	list(): Promise<readonly Principal[]>;
	/** The identities linked to the principal. */
	identities(principalId: string): Promise<readonly IdentityLink[]>;
	/** The principal's lasting roles, granted by the configuration or the CLI. */
	roles(principalId: string): Promise<readonly RoleGrant[]>;
	/** The tier of the principal's lasting roles; undefined when they hold none, are disabled, or are unknown. */
	tierOf(principalId: string): Promise<Tier | undefined>;
	/**
	 * A speaker for a turn started on a principal's behalf, at `tier` or their own, whichever is
	 * lower. Their own is their lasting roles' tier, or, when their tier comes only from the rules
	 * on contact, the tier they were last seen at, refused once `access.backgroundStaleDays` pass
	 * unseen or once a contact of theirs is refused. Throws IdentityError for a principal that is
	 * unknown, disabled, or holds no tier, and for the system principal, whose turns only the core
	 * starts.
	 */
	speakerFor(principalId: string, tier?: Tier): Promise<Speaker>;
	/** The principals holding the owner role, the configured owners first in their order. */
	owners(): Promise<readonly Principal[]>;
}

/** The system principal's speaker for a turn the core itself starts, such as an ops report, at the tier its starter gives. Core-internal: no plugin reaches it. */
export function systemSpeaker(tier: Tier): Speaker {
	return {
		id: SYSTEM_PRINCIPAL,
		name: SYSTEM_PRINCIPAL,
		tier,
		principalId: SYSTEM_PRINCIPAL,
	};
}

/** A copy of what the service read, frozen all the way down, so no caller can change what the service holds. */
function frozenCopy<T>(value: T): T {
	return value === undefined
		? value
		: (freeze(structuredClone(value) as object) as T);
}

/**
 * The service as plugins get it: only its reads, frozen, with no way to its store. Each returns a
 * frozen copy, so a plugin that sorts or changes what it got changes no one's tier.
 */
export function identityView(service: IdentityService): IdentityService {
	return Object.freeze({
		resolve: async (facts, scope) =>
			frozenCopy(await service.resolve(facts, scope)),
		principal: async (id) => frozenCopy(await service.principal(id)),
		list: async () => frozenCopy(await service.list()),
		identities: async (principalId) =>
			frozenCopy(await service.identities(principalId)),
		roles: async (principalId) => frozenCopy(await service.roles(principalId)),
		tierOf: (principalId) => service.tierOf(principalId),
		speakerFor: async (principalId, tier) =>
			frozenCopy(await service.speakerFor(principalId, tier)),
		owners: async () => frozenCopy(await service.owners()),
	} satisfies IdentityService);
}

/** How often being seen is written for one principal, unless the tier changes. */
const TOUCH_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

const highest = (tiers: readonly (Tier | undefined)[]): Tier | undefined =>
	tiers.reduce<Tier | undefined>(
		(best, tier) =>
			tier !== undefined && (best === undefined || tierAtLeast(tier, best))
				? tier
				: best,
		undefined,
	);

const lowest = (a: Tier, b: Tier): Tier => (tierAtLeast(a, b) ? b : a);

const publicOf = (record: PrincipalRecord): Principal => ({
	id: record.id,
	displayName: record.displayName,
	...(record.pronouns ? { pronouns: record.pronouns } : {}),
	disabled: record.disabled,
});

export interface IdentityServiceOptions {
	logger: Logger;
	/** The clock, in milliseconds; a test gives its own. */
	now?: () => number;
}

/** The identity service over the principal store and the configured access rules. */
export class PgIdentityService implements IdentityService {
	/** The stored principals, written through it seen at once by this process. Core-internal: plugins get `identityView`. */
	readonly store: PrincipalStore;
	readonly #rules: AccessRules;
	readonly #logger: Logger;
	readonly #now: () => number;
	/** When each principal was last written as seen, and at which tier, null for none. */
	readonly #seen = new Map<string, { at: number; tier: Tier | null }>();
	/** The configured owners' principal ids, in the configuration's order, once synced. */
	#configOwners: string[] = [];

	constructor(
		store: PrincipalStore,
		rules: AccessRules,
		options: IdentityServiceOptions,
	) {
		this.#now = options.now ?? Date.now;
		this.store = new CachingPrincipalStore(store, this.#now);
		this.#rules = checkAccessRules(rules);
		this.#logger = options.logger;
	}

	/**
	 * Makes the stored owners match the configuration: each configured owner's principal made or
	 * renamed, their identities linked, and the owner role granted, all as the configuration's;
	 * the configuration's owner roles and links it no longer names are removed, the CLI's kept.
	 * An identity of an owner that is linked to another principal stops the boot.
	 */
	async syncConfig(): Promise<void> {
		const store = this.store;
		const owners: string[] = [];
		const identities = new Set<string>();
		for (const [n, owner] of this.#rules.owners.entries()) {
			const refs = owner.identities.map((identity) => {
				const ref = parseIdentity(identity);
				// checkAccessRules refused any identity that does not parse.
				if (!ref)
					throw new ConfigError(`config access.owners[${n}]: ${identity}`);
				return ref;
			});
			const links = await Promise.all(
				refs.map((ref) => store.identity(ref.provider, ref.subject)),
			);
			let id = owner.principal;
			links.forEach((link, i) => {
				if (!link) return;
				id ??= link.principalId;
				if (link.principalId !== id)
					throw new ConfigError(
						`config access.owners[${n}].identities[${i}]: ${owner.identities[i]} is linked to principal ${link.principalId}, not to this owner's ${id}. Unlink it with roundtable principal unlink ${owner.identities[i]}, or fix the configuration.`,
					);
			});
			const pronouns = owner.pronouns ?? null;
			const existing = id === undefined ? undefined : await store.get(id);
			const principal = existing
				? ((await store.update(existing.id, {
						displayName: owner.name,
						pronouns,
					})) ?? existing)
				: await store.create({
						...(id === undefined ? {} : { id }),
						displayName: owner.name,
						...(owner.pronouns ? { pronouns: owner.pronouns } : {}),
					});
			for (const ref of refs) {
				await store.link(principal.id, ref, "config");
				identities.add(identityOf(ref));
			}
			await store.grant(principal.id, "owner", "config");
			owners.push(principal.id);
		}
		for (const holder of await store.holders("owner"))
			if (holder.source === "config" && !owners.includes(holder.principalId)) {
				await store.revoke(holder.principalId, "owner", "config");
				this.#logger.info(
					`principal ${holder.principalId} is no longer a configured owner; its configured owner role was revoked`,
				);
			}
		for (const link of await store.linksFrom("config"))
			if (!identities.has(identityOf(link))) {
				await store.unlink(link.provider, link.subject);
				this.#logger.info(
					`${identityOf(link)} is no longer a configured owner's identity; it was unlinked from principal ${link.principalId}`,
				);
			}
		this.#configOwners = owners;
	}

	async resolve(
		facts: ActorFacts,
		scope: { conversation?: ChannelKey } = {},
	): Promise<Speaker | undefined> {
		const link =
			(await this.store.identity(facts.provider, facts.subject)) ??
			(await this.#claim(facts)) ??
			(await this.#admit(facts, scope.conversation));
		if (!link) return undefined;
		const principal = await this.store.get(link.principalId);
		if (!principal || principal.disabled) return undefined;
		const tier = await this.#tier(principal.id, facts, scope.conversation);
		// Refused now, so seen at no tier: their background turns stop with it.
		await this.#touch(principal, tier ?? null);
		if (!tier) return undefined;
		return {
			id: facts.legacyId ?? identityOf(facts),
			name: facts.name,
			tier,
			principalId: principal.id,
		};
	}

	async principal(id: string): Promise<Principal | undefined> {
		const record = await this.store.get(id);
		return record && publicOf(record);
	}

	async list(): Promise<readonly Principal[]> {
		return (await this.store.list()).map(publicOf);
	}

	identities(principalId: string): Promise<readonly IdentityLink[]> {
		return this.store.identitiesOf(principalId);
	}

	roles(principalId: string): Promise<readonly RoleGrant[]> {
		return this.store.rolesOf(principalId);
	}

	async tierOf(principalId: string): Promise<Tier | undefined> {
		const principal = await this.store.get(principalId);
		if (!principal || principal.disabled) return undefined;
		return this.#lastingTier(principalId);
	}

	async speakerFor(principalId: string, tier?: Tier): Promise<Speaker> {
		if (principalId === SYSTEM_PRINCIPAL)
			throw new IdentityError(
				`only the host itself speaks as the system principal "${SYSTEM_PRINCIPAL}"`,
			);
		const principal = await this.store.get(principalId);
		if (!principal)
			throw new IdentityError(`there is no principal ${principalId}`);
		if (principal.disabled)
			throw new IdentityError(`principal ${principalId} is disabled`);
		const cap =
			(await this.#lastingTier(principalId)) ?? this.#lastSeenTier(principal);
		return {
			id: principal.id,
			name: principal.displayName,
			tier: tier ? lowest(tier, cap) : cap,
			principalId: principal.id,
		};
	}

	async owners(): Promise<readonly Principal[]> {
		const holders = (await this.store.holders("owner")).map(
			(holder) => holder.principalId,
		);
		const order = (id: string) => {
			const at = this.#configOwners.indexOf(id);
			return at < 0 ? this.#configOwners.length : at;
		};
		holders.sort((a, b) => order(a) - order(b) || a.localeCompare(b));
		const owners: Principal[] = [];
		for (const id of holders) {
			const principal = await this.principal(id);
			if (principal && !principal.disabled) owners.push(principal);
		}
		return owners;
	}

	/** The tier of the principal's lasting roles, if any. */
	async #lastingTier(principalId: string): Promise<Tier | undefined> {
		const roles: RoleGrant[] = await this.store.rolesOf(principalId);
		return highest(roles.map((grant) => grant.role));
	}

	/** The tier a principal without lasting roles was last seen at, while it is fresh. */
	#lastSeenTier(principal: PrincipalRecord): Tier {
		const { lastTier, lastSeenAt } = principal;
		if (!lastTier || !lastSeenAt)
			throw new IdentityError(`principal ${principal.id} holds no tier`);
		const days = this.#rules.backgroundStaleDays;
		if (this.#now() - lastSeenAt.getTime() > days * DAY_MS)
			throw new IdentityError(
				`principal ${principal.id} holds no lasting role and was last seen more than ${days} days ago (access.backgroundStaleDays)`,
			);
		return lastTier;
	}

	async #tier(
		principalId: string,
		facts: ActorFacts,
		conversation: ChannelKey | undefined,
	): Promise<Tier | undefined> {
		return highest([
			await this.#lastingTier(principalId),
			factsTier(this.#rules, facts, conversation),
		]);
	}

	/**
	 * The principal of the facts' 0.8 id, linked to them, while the backfill's claim on it is
	 * unspent: no identity was ever linked to it, and it holds no owner role.
	 */
	async #claim(facts: ActorFacts): Promise<IdentityLink | undefined> {
		const id = facts.legacyId;
		if (this.#rules.provisioning !== "admitted") return undefined;
		if (id === undefined || id === SYSTEM_PRINCIPAL || isPrincipalId(id))
			return undefined;
		if (!(await this.store.get(id))?.claimable) return undefined;
		return this.store.claim(id, {
			provider: facts.provider,
			subject: facts.subject,
		});
	}

	/** A new principal for someone the rules admit, when the host admits people at first contact. */
	async #admit(
		facts: ActorFacts,
		conversation: ChannelKey | undefined,
	): Promise<IdentityLink | undefined> {
		if (this.#rules.provisioning !== "admitted") return undefined;
		if (!factsTier(this.#rules, facts, conversation)) return undefined;
		return this.store.admit(
			{ provider: facts.provider, subject: facts.subject },
			facts.name,
		);
	}

	/**
	 * Records the principal as seen at the tier, null when refused, at most every `TOUCH_MS`
	 * unless the tier changed; a refusal is written whenever the store still holds a tier for them.
	 * A failure is logged, not thrown.
	 */
	async #touch(principal: PrincipalRecord, tier: Tier | null): Promise<void> {
		const principalId = principal.id;
		const now = this.#now();
		const last = this.#seen.get(principalId);
		const stored = tier !== null || principal.lastTier === undefined;
		if (last && last.tier === tier && now - last.at < TOUCH_MS && stored)
			return;
		this.#seen.set(principalId, { at: now, tier });
		try {
			await this.store.touch(principalId, tier, new Date(now));
		} catch (error) {
			this.#seen.delete(principalId);
			this.#logger.warn(
				{ err: error, principal: principalId },
				"could not record that a principal was seen",
			);
		}
	}
}
