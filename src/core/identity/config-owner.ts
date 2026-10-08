import { ConfigError } from "../domain/errors.ts";
import type { Logger } from "../log.ts";
import type { AccessOwner } from "./access-policy.ts";
import { identityOf } from "./actor-facts.ts";
import type { IdentityRef, PrincipalStore } from "./principal-store.ts";

/** A configured owner, where the configuration lists them, and what the boot knows of the plugins. */
export interface ConfiguredOwner {
	owner: AccessOwner;
	/** The owner's index in `access.owners`. */
	index: number;
	/** The owner's identities, parsed, in the configuration's order. */
	refs: readonly IdentityRef[];
	/** The plugin that declares each identity the plugins declare. */
	declaredBy: ReadonlyMap<string, string>;
	logger: Logger;
}

/**
 * The principal a configured owner is: their `principal`, else the principal an identity of theirs
 * is linked to; undefined for someone the boot makes. A plugin's credential is not the person's own
 * identity, so a plugin's link never tells who the owner is, and one no plugin declares any more is
 * unlinked first, as the boot would anyway. An identity linked to another principal stops the
 * boot, and so does a plugin's identity bound to someone other than this owner, or listed under an
 * owner nothing else tells.
 */
export async function configuredOwnerId(
	store: PrincipalStore,
	{ owner, index: n, refs, declaredBy, logger }: ConfiguredOwner,
): Promise<string | undefined> {
	const links = await Promise.all(
		refs.map(async (ref) => {
			const link = await store.identity(ref.provider, ref.subject);
			if (link?.source !== "plugin" || declaredBy.has(identityOf(link)))
				return link;
			// No plugin declares it any more, so this boot unlinks it anyway: before it tells anyone anything.
			await store.unlink(link.provider, link.subject);
			logger.info(
				`${identityOf(link)} is no longer an identity a plugin declares; it was unlinked from principal ${link.principalId}`,
			);
			return undefined;
		}),
	);
	let id = owner.principal;
	links.forEach((link, i) => {
		if (!link || link.source === "plugin") return;
		id ??= link.principalId;
		if (link.principalId !== id)
			throw new ConfigError(
				`config access.owners[${n}].identities[${i}]: ${owner.identities[i]} is linked to principal ${link.principalId}, not to this owner's ${id}. Unlink it with roundtable principal unlink ${owner.identities[i]}, or fix the configuration.`,
			);
	});
	links.forEach((link, i) => {
		if (link?.source !== "plugin" || link.principalId === id) return;
		const plugin = declaredBy.get(identityOf(link));
		const declared = `config access.owners[${n}].identities[${i}]: ${owner.identities[i]} is an identity plugin ${plugin} declares, bound to principal ${link.principalId}`;
		// The CLI refuses to unlink a plugin's identity: the plugin's options move it.
		throw new ConfigError(
			id === undefined
				? `${declared}, and a plugin's credential does not tell who this owner is. Remove it from access.owners[${n}].identities, or give this owner its principal and bind plugin ${plugin} to it.`
				: `${declared}, not to this owner's ${id}. Remove it from access.owners[${n}].identities, or bind plugin ${plugin} to ${id} in its options.`,
		);
	});
	return id;
}
