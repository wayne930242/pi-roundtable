import { freeze } from "../freeze.ts";
import type { ContactAssessor } from "./contact.ts";
import type { IdentityService } from "./identity-service.ts";

/** The core's own assessor behind each view it made, for the router. */
const assessors = new WeakMap<IdentityService, ContactAssessor>();
/** The core's reading of a 0.8 row's person id behind each view it made, for the background turns. */
const legacies = new WeakMap<
	IdentityService,
	(id: string) => Promise<string | undefined>
>();

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
	service: IdentityService &
		ContactAssessor & {
			principalOfLegacyId?(id: string): Promise<string | undefined>;
		},
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
		principalOf: (identity) => service.principalOf(identity),
	} satisfies IdentityService);
	assessors.set(view, service);
	const legacy = service.principalOfLegacyId?.bind(service);
	if (legacy) legacies.set(view, legacy);
	return view;
}

/**
 * The principal a person id a 0.8 row names stands for, such as a schedule's creator, through the
 * host's `IDENTITY`: the core's service reads 0.8's `remote-mcp` as the primary owner; a plugin's
 * replacement takes an id as the principal of that id. Core-internal.
 */
export function legacyPrincipalsOf(
	identity: IdentityService,
): (id: string) => Promise<string | undefined> {
	return (
		legacies.get(identity) ?? (async (id) => (await identity.principal(id))?.id)
	);
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
