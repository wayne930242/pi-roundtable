import { freeze } from "../freeze.ts";
import type { ContactAssessor } from "./contact.ts";
import type { IdentityService } from "./identity-service.ts";

/** The core's own assessor behind each view it made, for the router. */
const assessors = new WeakMap<IdentityService, ContactAssessor>();

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
export function identityView(
	service: IdentityService & ContactAssessor,
): IdentityService {
	const view = Object.freeze({
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
	assessors.set(view, service);
	return view;
}

/**
 * How the router assesses the people of messages through the host's `IDENTITY`: the core's
 * service assesses before a claim takes a message and writes only once one does; a plugin's
 * replacement, which only resolves, resolves at once.
 */
export function contactsOf(identity: IdentityService): ContactAssessor {
	return (
		assessors.get(identity) ?? {
			assess: async (facts, scope) => {
				const speaker = await identity.resolve(facts, scope);
				return speaker && { speaker, take: async () => speaker };
			},
		}
	);
}
