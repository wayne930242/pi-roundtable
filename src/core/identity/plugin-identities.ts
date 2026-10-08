import { ConfigError } from "../domain/errors.ts";
import type { Logger } from "../log.ts";
import type { PluginIdentity, RoundtablePlugin } from "../plugin.ts";
import { identityOf, parseIdentity } from "./actor-facts.ts";
import { type PrincipalStore, SYSTEM_PRINCIPAL } from "./principal-store.ts";

/** The only provider a plugin declares identities of: credentials of its own, which no surface reports. */
const PLUGIN_PROVIDER = "token";

/** An identity a plugin declares, with the plugin that declares it. */
export interface DeclaredIdentity extends PluginIdentity {
	plugin: string;
}

/**
 * Every identity the plugins declare, in their order, checked before anything is written: each
 * written `token:<subject>`, none bound to the system principal, and none declared twice.
 */
export function declaredIdentities(
	plugins: readonly RoundtablePlugin[],
): DeclaredIdentity[] {
	const declared: DeclaredIdentity[] = [];
	const by = new Map<string, string>();
	for (const plugin of plugins)
		for (const [i, { identity, principal }] of (
			plugin.identities ?? []
		).entries()) {
			const path = `plugin ${plugin.name}: identities[${i}]`;
			const ref = parseIdentity(identity);
			if (!ref)
				throw new ConfigError(
					`${path}: ${JSON.stringify(identity)} is not an identity written <provider>:<subject>`,
				);
			// No surface reports a token: identity, so linking it, which spends no claim, admits no one
			// as someone new, and goes when the plugin stops declaring it, touches no person's own account.
			if (ref.provider !== PLUGIN_PROVIDER)
				throw new ConfigError(
					`${path}: ${identity} is not a ${PLUGIN_PROVIDER}: identity. A plugin declares only the credentials it serves itself, written ${PLUGIN_PROVIDER}:<name>; a person's own ${ref.provider} identity is linked by access.owners or roundtable principal link.`,
				);
			if (principal === SYSTEM_PRINCIPAL)
				throw new ConfigError(
					`${path}: ${identity} is bound to the host's own principal "${SYSTEM_PRINCIPAL}", whose turns only the core starts; bind it to a person's principal`,
				);
			const text = identityOf(ref);
			const other = by.get(text);
			if (other !== undefined)
				throw new ConfigError(
					`${path}: ${text} is declared by plugin ${other} too. An identity stands for one principal; give one of the two another identity.`,
				);
			by.set(text, plugin.name);
			declared.push({
				plugin: plugin.name,
				identity: text,
				...(principal === undefined ? {} : { principal }),
			});
		}
	return declared;
}

/**
 * Links each identity a plugin declares to its principal, `primaryOwner` by default, as the
 * plugin's: one the plugins bound to another principal at an earlier boot moves, one the
 * configuration or the CLI linked to the same principal stays linked, and one the plugins no
 * longer declare is unlinked. A principal that does not exist, or an identity linked to someone
 * else in another way, stops the boot.
 */
export async function syncDeclaredIdentities(
	store: PrincipalStore,
	identities: readonly DeclaredIdentity[],
	primaryOwner: string | undefined,
	logger: Logger,
): Promise<void> {
	const declared = new Set<string>();
	for (const { plugin, identity, principal } of identities) {
		// declaredIdentities refused any identity that does not parse.
		const ref = parseIdentity(identity);
		if (!ref) throw new ConfigError(`plugin ${plugin}: ${identity}`);
		const id = principal ?? primaryOwner;
		if (id === undefined)
			throw new ConfigError(
				`plugin ${plugin}: ${identity} names no principal, and access.owners lists no primary owner to bind it to. Give the plugin the principal it stands for.`,
			);
		if (id === SYSTEM_PRINCIPAL || !(await store.get(id)))
			throw new ConfigError(
				`plugin ${plugin}: ${identity} is bound to principal ${id}, and there is no principal ${id}. roundtable principal list shows the principals, and roundtable principal create makes one.`,
			);
		const link = await store.identity(ref.provider, ref.subject);
		if (link && link.principalId !== id) {
			if (link.source !== "plugin")
				throw new ConfigError(
					`plugin ${plugin}: ${identity} is linked to principal ${link.principalId}, not to ${id} the plugin binds it to. ${link.source === "config" ? "access.owners lists it under that owner: remove it there," : `Unlink it with roundtable principal unlink ${identity},`} or bind the plugin to ${link.principalId}.`,
				);
			// Bound to another principal than at the last boot: it moves.
			await store.unlink(ref.provider, ref.subject);
			logger.info(
				`${identity} of plugin ${plugin} moved from principal ${link.principalId} to ${id}`,
			);
		}
		await store.link(id, ref, "plugin");
		declared.add(identity);
	}
	for (const link of await store.linksFrom("plugin"))
		if (!declared.has(identityOf(link))) {
			await store.unlink(link.provider, link.subject);
			logger.info(
				`${identityOf(link)} is no longer an identity a plugin declares; it was unlinked from principal ${link.principalId}`,
			);
		}
}
