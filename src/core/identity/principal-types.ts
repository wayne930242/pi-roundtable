import type { Pronouns } from "../config/config.ts";
import type { Tier } from "../speakers.ts";

export type { Pronouns };

/** A person the host serves, whichever surface they reach it through. */
export interface Principal {
	/** Opaque: a speaker id carried over from 0.8, or `p_<ulid>` for one made since. */
	id: string;
	displayName: string;
	pronouns?: Pronouns;
	disabled: boolean;
}

/** A principal as stored, with when it was made and when it was last seen. */
export interface PrincipalRecord extends Principal {
	locale?: string;
	timeZone?: string;
	createdAt: Date;
	lastSeenAt?: Date;
	/** The tier it was last seen at; it only ever lowers what a background turn may do, never grants. */
	lastTier?: Tier;
	/** Whether the person of its 0.8 speaker id may still claim it: only one the backfill made, until any identity is linked to it. */
	claimable: boolean;
}

/** An identity on one provider: `discord` and a user id, `oidc:<issuer>` and a subject, `token` and a name. */
export interface IdentityRef {
	provider: string;
	subject: string;
}

/**
 * How an identity came to be linked: by the configuration, a plugin declaring it
 * (`RoundtablePlugin.identities`), the CLI, admission on first contact, a 0.8 speaker id claimed,
 * or the person themself through `IDENTITY_LINKS` (`self`).
 */
export type LinkSource =
	| "config"
	| "plugin"
	| "cli"
	| "jit"
	| "legacy"
	| "self";

export interface IdentityLink extends IdentityRef {
	principalId: string;
	source: LinkSource;
	linkedAt: Date;
}

/** Where a role came from. The configuration's are synced at every boot; a CLI grant stays until the CLI revokes it. */
export type RoleSource = "config" | "cli";

export interface RoleGrant {
	role: Tier;
	source: RoleSource;
	grantedAt: Date;
}

/** A principal holding a role, and where the role came from. */
export interface RoleHolder {
	principalId: string;
	source: RoleSource;
}

export interface NewPrincipal {
	/** The id to keep, for a principal carried over from 0.8; otherwise a new `p_` id is made. */
	id?: string;
	displayName: string;
	pronouns?: Pronouns;
}

/** The principals, their linked identities, and their lasting roles. */
export interface PrincipalStore {
	get(id: string): Promise<PrincipalRecord | undefined>;
	list(): Promise<PrincipalRecord[]>;
	/** Refuses an id already taken, and the system principal's. */
	create(input: NewPrincipal): Promise<PrincipalRecord>;
	/** Changes the name or the pronouns; `pronouns: null` clears them. */
	update(
		id: string,
		change: { displayName?: string; pronouns?: Pronouns | null },
	): Promise<PrincipalRecord | undefined>;
	/**
	 * Links the identity to the principal; linking it again to the same one changes nothing, but
	 * that the configuration linking it makes the link the configuration's, and a plugin linking it
	 * makes one the CLI, a first contact, or a claim made the plugin's; to another one is refused. A
	 * principal with any identity linked is no longer claimable, even after the identity is
	 * unlinked, except by a plugin's link: a plugin's credential is not the person's own identity,
	 * so it leaves their 0.8 claim to them.
	 */
	link(
		principalId: string,
		identity: IdentityRef,
		source: LinkSource,
	): Promise<IdentityLink>;
	/**
	 * The identity's link, claiming the principal for it when the identity is still unlinked and
	 * the principal claimable and not an owner; undefined when it may not be claimed. A principal
	 * is claimed at most once. A claim names the principal `displayName`, when given, while its
	 * name is still its id, as the backfill names someone it knows no name of; a real name stays.
	 */
	claim(
		principalId: string,
		identity: IdentityRef,
		displayName?: string,
	): Promise<IdentityLink | undefined>;
	/**
	 * The identity's link, making a new `p_` principal for it, of `id` when given, when it is still
	 * unlinked; however many contacts admit it at once, one principal is made.
	 */
	admit(
		identity: IdentityRef,
		displayName: string,
		id?: string,
	): Promise<IdentityLink>;
	/** Whether there was a link to remove; with `source`, only a link made by it is removed. */
	unlink(
		provider: string,
		subject: string,
		source?: LinkSource,
	): Promise<boolean>;
	identity(
		provider: string,
		subject: string,
	): Promise<IdentityLink | undefined>;
	identitiesOf(principalId: string): Promise<IdentityLink[]>;
	/** Every link made by `source`, such as the configuration's. */
	linksFrom(source: LinkSource): Promise<IdentityLink[]>;
	/** Grants a lasting role. A CLI grant is kept as the CLI's even when the configuration grants the same role. */
	grant(principalId: string, role: Tier, source: RoleSource): Promise<void>;
	/** Revokes the role, or only the grant from `source`; whether there was one to revoke. */
	revoke(
		principalId: string,
		role: Tier,
		source?: RoleSource,
	): Promise<boolean>;
	rolesOf(principalId: string): Promise<RoleGrant[]>;
	/** Every principal holding the role. */
	holders(role: Tier): Promise<RoleHolder[]>;
	disable(id: string): Promise<void>;
	enable(id: string): Promise<void>;
	/** Records that the principal was seen at `at` (default now), at this tier, or null when refused. */
	touch(id: string, tier: Tier | null, at?: Date): Promise<void>;
}
