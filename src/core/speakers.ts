import { freeze } from "./freeze.ts";
import {
	rulesOfSpeakerMap,
	speakerPolicyOf,
} from "./identity/access-policy.ts";
import type { OwnerIdentity } from "./identity.ts";

/** How much a speaker may do: `owner` above `admin` above `member`. */
export const TIERS = Object.freeze(["member", "admin", "owner"] as const);
export type Tier = (typeof TIERS)[number];

/** Whether `tier` is `least` or above. */
export function tierAtLeast(tier: Tier, least: Tier): boolean {
	return TIERS.indexOf(tier) >= TIERS.indexOf(least);
}

/** A person whose message starts a turn, and the tier the policy gave them. */
export interface Speaker {
	/** The id the surface knows them by: a Discord user id, a web chat's `oidc:<issuer>:<subject>`. */
	id: string;
	name: string;
	tier: Tier;
	/**
	 * The principal they are, whose memory, schedules, and conversations are theirs on every
	 * surface. For a person carried over from 0.8 it equals `id`. The identity service sets it.
	 */
	principalId?: string;
}

/**
 * Who a prompt addresses for this speaker: the owner for an owner-tier speaker, so the owner's
 * prompts stay as they are, and otherwise the speaker by name, since a name needs no guess at
 * pronouns.
 */
export function addressee(
	speaker: Speaker | undefined,
	owner: OwnerIdentity,
): OwnerIdentity {
	if (!speaker || speaker.tier === "owner") return owner;
	return {
		name: speaker.name,
		pronouns: {
			subject: speaker.name,
			object: speaker.name,
			possessive: `${speaker.name}'s`,
		},
	};
}

/**
 * How a tool description names the person it serves in a session that several speakers share:
 * the description is fixed when the session opens, so it names no one, and the prompt says who
 * the speaker is.
 */
export const THE_SPEAKER: Readonly<Omit<OwnerIdentity, "pronouns">> & {
	readonly pronouns: Readonly<OwnerIdentity["pronouns"]>;
} = freeze({
	name: "the speaker",
	pronouns: {
		subject: "the speaker",
		object: "the speaker",
		possessive: "the speaker's",
	},
});

/** The turn's text under the speaker's name, so a conversation several speakers share says who wrote what. */
export function attributed(speaker: Speaker, text: string): string {
	if (speaker.tier === "owner") return text;
	return `(Message from ${speaker.name}, at the ${speaker.tier} tier.)\n\n${text}`;
}

/**
 * What a surface reports about the author of a message; the policy decides the rest. The 0.8
 * form of `ActorFacts` from the identity service, with the surface's own ids and role ids.
 */
export interface SpeakerFacts {
	id: string;
	name: string;
	/** The roles the author holds in the server; empty where the surface has none. */
	roleIds?: readonly string[];
}

/**
 * Decides who may talk to the agents. Undefined means the author is nobody: no reply and no
 * turn. A plugin may replace the configured policy.
 */
export interface SpeakerPolicy {
	resolve(author: SpeakerFacts): Speaker | undefined;
}

/**
 * Who holds one tier: user ids, role ids, or everyone. `everyone` works under any tier it is
 * written in, so under `admins` it makes every author an admin.
 */
export interface TierMembers {
	users?: readonly string[];
	roles?: readonly string[];
	everyone?: boolean;
}

export interface SpeakerMap {
	/** User ids of the owners. */
	owners: readonly string[];
	admins?: TierMembers;
	members?: TierMembers;
}

/**
 * The policy of an operator's map; the highest tier an author qualifies for wins. It evaluates
 * the access rules the map means on one surface, so it decides as the identity service's rules
 * do; its speakers carry no principal.
 */
export function speakerPolicy(map: SpeakerMap): SpeakerPolicy {
	return speakerPolicyOf(rulesOfSpeakerMap(map));
}
