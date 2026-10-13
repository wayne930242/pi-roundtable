import { IdentityError } from "../domain/errors.ts";
import { freeze } from "../freeze.ts";
import type { Logger } from "../log.ts";
import type { SelfLinkRules } from "./access-policy.ts";
import { identityOf, parseIdentity } from "./actor-facts.ts";
import {
	type IdentityLink,
	type IdentityRef,
	type PrincipalStore,
	SYSTEM_PRINCIPAL,
} from "./principal-store.ts";

/**
 * The links people make to their own principal: a plugin that proved who someone is, such as one
 * that checked a code against a signed-in person, links the account that person controls. Provided
 * as `IDENTITY_LINKS` only when the configuration lists the providers in `access.selfLink`;
 * `IDENTITY` stays read-only. A link made here has the source `self`, and only such a link is
 * unlinked here.
 */
export interface IdentityLinks {
	/**
	 * Links the identity, written `<provider>:<subject>`, to the principal, and gives the link.
	 * Linking it again to the same principal changes nothing, also when the principal has since been
	 * granted the owner role: a link made before keeps. Throws IdentityError for a provider
	 * `access.selfLink` does not list, the system principal, a principal that holds the owner role
	 * or does not exist, text that is no identity, and an identity linked to another principal.
	 */
	link(principalId: string, identity: string): Promise<IdentityLink>;
	/**
	 * Unlinks the identity; true when a self link was removed, false when there was none to remove
	 * (it was linked to no one, or its link went away meanwhile). Throws IdentityError for a link
	 * another source made, such as the configuration or the CLI: those are not unlinked here.
	 */
	unlink(identity: string): Promise<boolean>;
}

/** The self-link service over the principal store, for the providers the configuration lists. */
export function identityLinks(
	store: PrincipalStore,
	rules: SelfLinkRules,
	logger: Logger,
): IdentityLinks {
	const parse = (identity: string): IdentityRef => {
		const ref = parseIdentity(identity);
		if (!ref)
			throw new IdentityError(
				`${JSON.stringify(identity)} is not an identity written <provider>:<subject>`,
			);
		return ref;
	};
	return Object.freeze({
		async link(principalId, identity) {
			const ref = parse(identity);
			if (!rules.providers.includes(ref.provider))
				throw new IdentityError(
					`${ref.provider} identities may not be linked by their person: access.selfLink lists ${rules.providers.join(", ")}`,
				);
			if (principalId === SYSTEM_PRINCIPAL)
				throw new IdentityError(
					`the host's own principal "${SYSTEM_PRINCIPAL}" has no identities`,
				);
			const link = await store.link(principalId, ref, "self");
			logger.info(
				{
					principal: principalId,
					identity: identityOf(ref),
					source: link.source,
				},
				"an identity was linked by its person",
			);
			return freeze(structuredClone(link));
		},
		async unlink(identity) {
			const ref = parse(identity);
			// The cached read only names the principal in the log: it may be up to 30 s old, so it
			// decides nothing. Only a self link goes: one the configuration or the CLI took over is kept.
			const before = await store.identity(ref.provider, ref.subject);
			const removed = await store.unlink(ref.provider, ref.subject, "self");
			if (removed) {
				logger.info(
					{ principal: before?.principalId, identity: identityOf(ref) },
					"an identity was unlinked by its person",
				);
				return true;
			}
			// Nothing went: read again (a write through the store drops its cached reads) to tell a link
			// another source took over from one that is gone.
			const now = await store.identity(ref.provider, ref.subject);
			if (now && now.source !== "self")
				throw new IdentityError(
					`${identityOf(ref)} was linked by ${now.source}, not by its person; it is not unlinked here`,
				);
			return false;
		},
	} satisfies IdentityLinks);
}
