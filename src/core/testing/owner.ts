import type { OwnerIdentity } from "../identity.ts";
import type { Speaker } from "../speakers.ts";

/** The owner tests speak for; its words match the texts the tests expect. */
export const TEST_OWNER: OwnerIdentity = {
	name: "Riley",
	pronouns: { subject: "he", object: "him", possessive: "his" },
};

/** The owner as a speaker of the tests. */
export const OWNER_SPEAKER: Speaker = {
	id: "1",
	name: TEST_OWNER.name,
	tier: "owner",
};
