import type { ActorFacts } from "../identity/actor-facts.ts";
import type { ContactAssessor } from "../identity/contact.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import { type SpeakerMap, speakerPolicy } from "../speakers.ts";

/**
 * Who a 0.8 speaker map serves, for a test without a database: each person their own principal,
 * as one carried over from 0.8 is, and nothing written. It resolves as the router's assessor
 * and as the `resolve` of `IDENTITY`.
 */
export function mapIdentity(
	map: SpeakerMap,
): ContactAssessor & Pick<IdentityService, "resolve"> {
	const policy = speakerPolicy(map);
	const resolve = async (facts: ActorFacts) =>
		policy.resolve({
			id: facts.subject,
			name: facts.name,
			roleIds: (facts.roles ?? []).map((role) =>
				role.replace(/^discord:role:/, ""),
			),
		});
	return {
		resolve,
		assess: async (facts) => {
			const speaker = await resolve(facts);
			return speaker && { speaker, take: async () => speaker };
		},
	};
}
