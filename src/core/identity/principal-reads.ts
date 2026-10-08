import { type Speaker, type Tier, tierAtLeast } from "../speakers.ts";
import { type ActorFacts, identityOf } from "./actor-facts.ts";
import type { Principal, PrincipalRecord } from "./principal-store.ts";

/** The speaker of a contact: the id the surface knows them by, their 0.8 id where they have one. */
export const speakerOf = (
	facts: ActorFacts,
	principalId: string,
	tier: Tier,
): Speaker => ({
	id: facts.legacyId ?? identityOf(facts),
	name: facts.name,
	tier,
	principalId,
});

/** The highest of the tiers given, undefined for none. */
export const highest = (
	tiers: readonly (Tier | undefined)[],
): Tier | undefined =>
	tiers.reduce<Tier | undefined>(
		(best, tier) =>
			tier !== undefined && (best === undefined || tierAtLeast(tier, best))
				? tier
				: best,
		undefined,
	);

/** The lower of two tiers. */
export const lowest = (a: Tier, b: Tier): Tier => (tierAtLeast(a, b) ? b : a);

/** A stored principal as the identity service shows it. */
export const publicOf = (record: PrincipalRecord): Principal => ({
	id: record.id,
	displayName: record.displayName,
	...(record.pronouns ? { pronouns: record.pronouns } : {}),
	disabled: record.disabled,
});
