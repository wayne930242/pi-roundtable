import { ConfigError } from "../domain/errors.ts";
import type { Logger } from "../log.ts";
import type { AccessOwner } from "./access-policy.ts";
import { identityOf } from "./actor-facts.ts";
import type { DeclaredIdentity } from "./plugin-identities.ts";
import type {
	IdentityLink,
	IdentityRef,
	PrincipalStore,
} from "./principal-store.ts";

/** A configured owner, where the configuration lists them, and what the boot knows of the plugins. */
export interface ConfiguredOwner {
	owner: AccessOwner;
	/** The owner's index in `access.owners`. */
	index: number;
	/** The owner's identities, parsed, in the configuration's order. */
	refs: readonly IdentityRef[];
	/** Each identity the plugins declare, with the plugin and the principal it names. */
	declaredBy: ReadonlyMap<string, DeclaredIdentity>;
	/** The primary owner's principal, which a plugin naming none binds to; undefined while syncing the primary owner. */
	primary: string | undefined;
	logger: Logger;
}

/** A configured owner's identity that stops the start, and how to fix it. */
export interface OwnerConflict {
	problem: string;
	fix: string;
}

/**
 * Whether a configured owner may list an identity a plugin declares. The principal the plugin binds
 * it to on this boot, its `principal` or else the primary owner, must be this owner, whatever it
 * was bound to before: the boot moves it there. A plugin's credential never tells who the owner is,
 * so an owner nothing else tells conflicts unless they are the primary owner the plugin defaults to
 * and the credential is not a plugin's link to someone already. `primary` undefined with `first`
 * false is a primary owner the start makes.
 */
export function declaredConflict({
	index: n,
	i,
	identity,
	id,
	link,
	declared: { plugin, principal },
	primary,
	first,
}: {
	index: number;
	i: number;
	identity: string;
	/** The principal this owner is, as everything but a plugin's credential tells; undefined for one the boot makes. */
	id: string | undefined;
	link: IdentityLink | undefined;
	declared: DeclaredIdentity;
	primary: string | undefined;
	first: boolean;
}): OwnerConflict | undefined {
	const at = `access.owners[${n}].identities[${i}]: ${identity} is an identity plugin ${plugin} declares`;
	const remove = `Remove it from access.owners[${n}].identities`;
	const untold: OwnerConflict = {
		problem: "a plugin's credential does not tell who this owner is",
		fix: `${remove}, or give this owner its principal and bind plugin ${plugin} to it`,
	};
	if (principal === undefined && first) {
		// Bound to this owner, the primary owner: whoever they are, unless only that link would tell.
		if (id !== undefined || link?.source !== "plugin") return undefined;
		return {
			...untold,
			problem: `${at}, bound to principal ${link.principalId}, and ${untold.problem}`,
		};
	}
	const target = principal ?? primary;
	if (target !== undefined && target === id) return undefined;
	const bound = `${at}, bound to ${target === undefined ? "the principal the start makes for access.owners[0]" : `principal ${target}`}`;
	return id === undefined
		? { ...untold, problem: `${bound}, and ${untold.problem}` }
		: {
				problem: `${bound}, not to this owner's ${id}`,
				fix: `${remove}, or bind plugin ${plugin} to ${id} in its options`,
			};
}

/**
 * The principal a configured owner is: their `principal`, else the principal an identity of theirs
 * is linked to; undefined for someone the boot makes. A plugin's credential is not the person's own
 * identity, so a plugin's link never tells who the owner is, and one no plugin declares any more is
 * unlinked first, as the boot would anyway. An identity linked to another principal stops the
 * boot, and so does an identity a plugin declares that `declaredConflict` refuses. One a plugin
 * declares and binds to this owner on this boot, still the plugin's link to someone else, is moved
 * now, before the owner's identities are linked.
 */
export async function configuredOwnerId(
	store: PrincipalStore,
	{ owner, index: n, refs, declaredBy, primary, logger }: ConfiguredOwner,
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
	for (const [i, ref] of refs.entries()) {
		const declared = declaredBy.get(identityOf(ref));
		if (!declared) continue;
		const link = links[i];
		const conflict = declaredConflict({
			index: n,
			i,
			identity: owner.identities[i] ?? identityOf(ref),
			id,
			link,
			declared,
			primary,
			first: n === 0,
		});
		// The CLI refuses to unlink a plugin's identity: the plugin's options move it.
		if (conflict)
			throw new ConfigError(`config ${conflict.problem}. ${conflict.fix}.`);
		if (link?.source !== "plugin" || link.principalId === id) continue;
		// The plugin binds it to this owner on this boot, and a link refuses an identity linked elsewhere.
		await store.unlink(link.provider, link.subject);
		logger.info(
			`${identityOf(link)} of plugin ${declared.plugin} moved from principal ${link.principalId} to ${id}`,
		);
	}
	return id;
}
