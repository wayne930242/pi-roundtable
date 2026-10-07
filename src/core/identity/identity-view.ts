import { freeze } from "../freeze.ts";
import type { IdentityService } from "./identity-service.ts";

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
export function identityView(service: IdentityService): IdentityService {
	return Object.freeze({
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
}
