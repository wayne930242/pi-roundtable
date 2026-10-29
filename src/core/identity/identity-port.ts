import type { ChannelKey } from "../sessions.ts";
import type { Speaker, Tier } from "../speakers.ts";
import type { ActorFacts } from "./actor-facts.ts";
import type { IdentityLink, Principal, RoleGrant } from "./principal-store.ts";

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
	 * holds the owner role, taking the facts' name when the backfill named it by its id, and is
	 * otherwise admitted as a new principal when the rules give it a tier. Both happen only when `provisioning` is `admitted` on the contact's surface; under `linked` only identities
	 * already linked are served. A disabled principal is no one. The tier is the higher of the
	 * principal's lasting roles and what the rules give the facts on this contact.
	 */
	resolve(
		facts: ActorFacts,
		scope?: { conversation?: ChannelKey },
	): Promise<Speaker | undefined>;
	/**
	 * The speaker these facts resolve to now, read only: no link, claim, admission, seen-record or
	 * touch, also on a refusal. Its tier is exactly what `resolve` would give (the lasting roles
	 * together with what the rules give these facts), never the tier last recorded. Undefined for an
	 * unlinked identity, a disabled principal, or no tier.
	 */
	peek(
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
