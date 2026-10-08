import { ConfigError, IdentityError } from "../domain/errors.ts";
import type { Logger } from "../log.ts";
import type { ChannelKey } from "../sessions.ts";
import { type Speaker, type Tier, tierAtLeast } from "../speakers.ts";
import {
	type AccessRules,
	checkAccessRules,
	factsTier,
} from "./access-policy.ts";
import {
	type ActorFacts,
	identityOf,
	parseIdentity,
	surfaceOf,
} from "./actor-facts.ts";
import { CachingPrincipalStore } from "./caching-principal-store.ts";
import { configuredOwnerId } from "./config-owner.ts";
import type { Contact, ContactAssessor } from "./contact.ts";
import {
	type DeclaredIdentity,
	syncDeclaredIdentities,
} from "./plugin-identities.ts";
import { highest, lowest, publicOf, speakerOf } from "./principal-reads.ts";
import {
	type IdentityLink,
	LEGACY_PROVIDER,
	type Principal,
	type PrincipalRecord,
	type PrincipalStore,
	type RoleGrant,
	SYSTEM_PRINCIPAL,
} from "./principal-store.ts";
import { SeenThrottle } from "./seen-throttle.ts";
import { isPrincipalId, newPrincipalId } from "./ulid.ts";

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
	/**
	 * The id of the principal an identity, written `<provider>:<subject>`, is linked to, such as the
	 * one a plugin's declared identity stands for; undefined when it is linked to no one. Throws
	 * IdentityError for text that is no identity.
	 */
	principalOf(identity: string): Promise<string | undefined>;
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

const DAY_MS = 24 * 60 * 60_000;
/** How many people assessed at a first contact but not yet taken are remembered. */
const PROVISIONAL_MAX = 1_000;

export interface IdentityServiceOptions {
	logger: Logger;
	/** The identities the plugins declare, checked by `declaredIdentities`; `syncConfig` links them. */
	identities?: readonly DeclaredIdentity[];
	/** The clock, in milliseconds; a test gives its own. */
	now?: () => number;
}

/** The identity service over the principal store and the configured access rules. */
export class PgIdentityService implements IdentityService, ContactAssessor {
	/** The stored principals, written through it seen at once by this process. Core-internal: plugins get `identityView`. */
	readonly store: PrincipalStore;
	readonly #rules: AccessRules;
	readonly #logger: Logger;
	readonly #now: () => number;
	/** When each principal is written as seen. */
	readonly #seen = new SeenThrottle();
	/** The new principal id each person assessed at a first contact would get, until it is taken. */
	readonly #provisional = new Map<string, string>();
	/** The identities the plugins declare. */
	readonly #declared: readonly DeclaredIdentity[];
	/**
	 * The identities linked only at boot, as `<provider>:<subject>`: those the configuration lists
	 * under an owner and those the plugins declare.
	 */
	readonly #bootIdentities: ReadonlySet<string>;
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
		this.#declared = options.identities ?? [];
		this.#bootIdentities = new Set([
			...this.#rules.owners.flatMap((owner) => owner.identities),
			...this.#declared.map((declared) => declared.identity),
		]);
		this.#logger = options.logger;
	}

	/**
	 * Makes the stored owners match the configuration: each configured owner's principal made or
	 * renamed, their identities linked, and the owner role granted, all as the configuration's;
	 * the configuration's owner roles and links it no longer names are removed, the CLI's kept.
	 * An identity of an owner that is linked to another principal stops the boot. Then the plugins'
	 * declared identities are linked, as `syncDeclaredIdentities` says.
	 */
	async syncConfig(): Promise<void> {
		const store = this.store;
		const owners: string[] = [];
		const identities = new Set<string>();
		const declaredBy = new Map(
			this.#declared.map(({ identity, plugin }) => [identity, plugin]),
		);
		for (const [n, owner] of this.#rules.owners.entries()) {
			const refs = owner.identities.map((identity) => {
				const ref = parseIdentity(identity);
				// checkAccessRules refused any identity that does not parse.
				if (!ref)
					throw new ConfigError(`config access.owners[${n}]: ${identity}`);
				return ref;
			});
			const id = await configuredOwnerId(store, {
				owner,
				index: n,
				refs,
				declaredBy,
				logger: this.#logger,
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
		await syncDeclaredIdentities(
			store,
			this.#declared,
			owners[0],
			this.#logger,
		);
	}

	async resolve(
		facts: ActorFacts,
		scope: { conversation?: ChannelKey } = {},
	): Promise<Speaker | undefined> {
		return (await this.assess(facts, scope))?.take();
	}

	/**
	 * The contact of these facts, read only: a linked identity's principal, else at a first contact
	 * the principal they would claim or be admitted as, the same new id for the same person until
	 * it is taken; undefined when the rules serve no one by them. A linked person refused here is
	 * recorded as seen at no tier, when the facts carry what the rules decide by.
	 */
	async assess(
		facts: ActorFacts,
		scope: { conversation?: ChannelKey } = {},
	): Promise<Contact | undefined> {
		// A 0.8 id standing for another principal is no surface's identity.
		if (facts.provider === LEGACY_PROVIDER) return undefined;
		const { conversation } = scope;
		const link = await this.store.identity(facts.provider, facts.subject);
		let assessed: { principalId: string; tier: Tier } | undefined;
		if (link) {
			const principal = await this.store.get(link.principalId);
			if (!principal || principal.disabled) return undefined;
			const tier = await this.#tier(principal.id, facts, conversation);
			if (!tier) {
				// Refused now, so seen at no tier: their background turns stop with it.
				if (this.#knowsRoles(facts, conversation))
					await this.#touch(principal, null);
				return undefined;
			}
			assessed = { principalId: principal.id, tier };
		} else assessed = await this.#firstContact(facts, conversation);
		if (!assessed) return undefined;
		const speaker = speakerOf(facts, assessed.principalId, assessed.tier);
		return {
			speaker,
			take: () => this.#take(facts, conversation, assessed.principalId),
		};
	}

	/**
	 * The principal a person id a 0.8 row names stands for, such as a schedule's author: the
	 * principal it was attributed to at the upgrade (the primary owner for `remote-mcp`), or else
	 * the principal of that id; undefined for none. Core-internal.
	 */
	async principalOfLegacyId(id: string): Promise<string | undefined> {
		const alias = await this.store.identity(LEGACY_PROVIDER, id);
		if (alias) return alias.principalId;
		return (await this.store.get(id))?.id;
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

	async principalOf(identity: string): Promise<string | undefined> {
		const ref = parseIdentity(identity);
		if (!ref)
			throw new IdentityError(
				`${JSON.stringify(identity)} is not an identity written <provider>:<subject>`,
			);
		return (await this.store.identity(ref.provider, ref.subject))?.principalId;
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

	/** Whether the facts carry what the rules decide by: the roles, when the rules name a role of their surface. */
	#knowsRoles(
		facts: ActorFacts,
		conversation: ChannelKey | undefined,
	): boolean {
		if (facts.roles !== undefined) return true;
		const prefix = `${surfaceOf(facts, conversation)}:role:`;
		return ![this.#rules.admins, this.#rules.members].some((tier) =>
			tier?.roles?.some((role) => role.startsWith(prefix)),
		);
	}

	/** The principal of the facts' 0.8 id while it may be claimed: made by the backfill, no identity ever linked to it, and no owner. */
	async #claimable(facts: ActorFacts): Promise<PrincipalRecord | undefined> {
		const id = facts.legacyId;
		if (id === undefined || id === SYSTEM_PRINCIPAL || isPrincipalId(id))
			return undefined;
		const principal = await this.store.get(id);
		if (!principal?.claimable) return undefined;
		if ((await this.#lastingTier(id)) === "owner") return undefined;
		return principal;
	}

	/** Who an unlinked person would be: the principal of their 0.8 id, or a new one the rules admit, when the host admits people at first contact. */
	async #firstContact(
		facts: ActorFacts,
		conversation: ChannelKey | undefined,
	): Promise<{ principalId: string; tier: Tier } | undefined> {
		if (this.#rules.provisioning !== "admitted") return undefined;
		// An owner's identity, or a plugin's, is its principal's alone, linked at boot: unlinked
		// meanwhile, it is no one until then.
		if (this.#bootIdentities.has(identityOf(facts))) return undefined;
		const claimable = await this.#claimable(facts);
		if (claimable) {
			// Disabled before they came back: no one, and no new principal either.
			if (claimable.disabled) return undefined;
			const tier = await this.#tier(claimable.id, facts, conversation);
			return tier && { principalId: claimable.id, tier };
		}
		const tier = factsTier(this.#rules, facts, conversation);
		if (!tier) return undefined;
		const key = `${facts.provider}\0${facts.subject}`;
		let id = this.#provisional.get(key);
		if (!id) {
			id = newPrincipalId();
			this.#provisional.set(key, id);
			// Those never taken, such as people writing where no claim answers, are forgotten oldest first.
			if (this.#provisional.size > PROVISIONAL_MAX)
				for (const old of this.#provisional.keys()) {
					this.#provisional.delete(old);
					break;
				}
		}
		return { principalId: id, tier };
	}

	/**
	 * Records a contact a claim took: links an unlinked person by claiming the principal of their
	 * 0.8 id, or else admitting them as the assessed new principal, then records them as seen.
	 */
	async #take(
		facts: ActorFacts,
		conversation: ChannelKey | undefined,
		assessed: string,
	): Promise<Speaker | undefined> {
		const ref = { provider: facts.provider, subject: facts.subject };
		let link = await this.store.identity(ref.provider, ref.subject);
		if (
			!link &&
			this.#rules.provisioning === "admitted" &&
			!this.#bootIdentities.has(identityOf(ref))
		) {
			if (assessed === facts.legacyId)
				link = await this.store.claim(assessed, ref);
			if (!link && factsTier(this.#rules, facts, conversation)) {
				link = await this.store.admit(
					ref,
					facts.name,
					isPrincipalId(assessed) ? assessed : undefined,
				);
				this.#provisional.delete(`${ref.provider}\0${ref.subject}`);
			}
		}
		if (!link) return undefined;
		const principal = await this.store.get(link.principalId);
		if (!principal || principal.disabled) return undefined;
		const tier = await this.#tier(principal.id, facts, conversation);
		if (!tier) {
			if (this.#knowsRoles(facts, conversation))
				await this.#touch(principal, null);
			return undefined;
		}
		// Facts without the roles the rules decide by may show less than the person holds: they lower nothing.
		if (
			this.#knowsRoles(facts, conversation) ||
			!principal.lastTier ||
			tierAtLeast(tier, principal.lastTier)
		)
			await this.#touch(principal, tier);
		return speakerOf(facts, principal.id, tier);
	}

	/**
	 * Records the principal as seen at the tier, null when refused, as `SeenThrottle` lets it.
	 * A failure is logged, not thrown.
	 */
	async #touch(principal: PrincipalRecord, tier: Tier | null): Promise<void> {
		const principalId = principal.id;
		const now = this.#now();
		const stored = tier !== null || principal.lastTier === undefined;
		if (!this.#seen.take(principalId, tier, now, stored)) return;
		try {
			await this.store.touch(principalId, tier, new Date(now));
		} catch (error) {
			this.#seen.forget(principalId);
			this.#logger.warn(
				{ err: error, principal: principalId },
				"could not record that a principal was seen",
			);
		}
	}
}
