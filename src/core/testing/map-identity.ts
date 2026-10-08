import { IdentityError } from "../domain/errors.ts";
import type { ActorFacts } from "../identity/actor-facts.ts";
import type { ContactAssessor } from "../identity/contact.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import type { IdentityLink, Principal } from "../identity/principal-store.ts";
import { type SpeakerMap, speakerPolicy, tierAtLeast } from "../speakers.ts";

/**
 * Who a 0.8 speaker map serves, for a test without a database: each person their own principal,
 * as one carried over from 0.8 is, and nothing written; a background turn runs as the person of
 * its principal id at the map's tier for their id with no roles. It resolves as the router's assessor
 * and as the `resolve` of `IDENTITY`; its owners are the map's, and a person has a Discord
 * identity once the map names their user id or they have been resolved through it.
 */
export function mapIdentity(
	map: SpeakerMap,
): ContactAssessor &
	Pick<IdentityService, "resolve" | "owners" | "identities" | "speakerFor"> {
	const policy = speakerPolicy(map);
	const linked = new Set([
		...map.owners,
		...(map.admins?.users ?? []),
		...(map.members?.users ?? []),
	]);
	const resolve = async (facts: ActorFacts) => {
		const speaker = policy.resolve({
			id: facts.subject,
			name: facts.name,
			roleIds: (facts.roles ?? []).map((role) =>
				role.replace(/^discord:role:/, ""),
			),
		});
		if (speaker) linked.add(speaker.id);
		return speaker;
	};
	const principal = (id: string): Principal => ({
		id,
		displayName: id,
		disabled: false,
	});
	return {
		resolve,
		assess: async (facts) => {
			const speaker = await resolve(facts);
			return speaker && { speaker, take: async () => speaker };
		},
		owners: async () => map.owners.map(principal),
		// Whom a background turn runs as: the person of the id at the map's tier for them, or lower.
		speakerFor: async (principalId, tier) => {
			const own = policy.resolve({
				id: principalId,
				name: principalId,
				roleIds: [],
			})?.tier;
			if (!own) throw new IdentityError(`there is no principal ${principalId}`);
			return {
				id: principalId,
				name: principalId,
				tier: tier && tierAtLeast(own, tier) ? tier : own,
				principalId,
			};
		},
		identities: async (principalId): Promise<IdentityLink[]> =>
			linked.has(principalId)
				? [
						{
							provider: "discord",
							subject: principalId,
							principalId,
							source: "legacy",
							linkedAt: new Date(0),
						},
					]
				: [],
	};
}
