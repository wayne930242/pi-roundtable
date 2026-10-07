import type { Principal } from "../identity/principal-store.ts";
import type { OwnerIdentity } from "../identity.ts";
import type { Speaker } from "../speakers.ts";

/** The owner tests speak for; its words match the texts the tests expect. */
export const TEST_OWNER: OwnerIdentity = {
	name: "Riley",
	pronouns: { subject: "he", object: "him", possessive: "his" },
};

/** The owner as a principal of the tests, its id the owner speaker's, as for an owner carried over from 0.8. */
export const OWNER_PRINCIPAL: Principal = {
	id: "1",
	displayName: TEST_OWNER.name,
	pronouns: "he",
	disabled: false,
};

/** A member as a principal of the tests. */
export const MEMBER_PRINCIPAL: Principal = {
	id: "2",
	displayName: "Bo",
	disabled: false,
};

/** The owner as a speaker of the tests. */
export const OWNER_SPEAKER: Speaker = {
	id: "1",
	name: TEST_OWNER.name,
	tier: "owner",
	principalId: OWNER_PRINCIPAL.id,
};
