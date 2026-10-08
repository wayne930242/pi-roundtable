import { AgentRunError, ConfigError } from "../domain/errors.ts";
import type { AccessRules, AccessTier } from "../identity/access-policy.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import { SYSTEM_PRINCIPAL } from "../identity/principal-store.ts";
import { formatModelRef, type ModelRef } from "../models.ts";
import type { RoundtablePlugin } from "../plugin.ts";

/**
 * The Pi provider pi-claude-bridge registers. Its sessions resume the history Claude Code stored
 * for a conversation, tool results as they came, rather than each request the core projects, so
 * the core's per-request hiding of private memory does not reach it.
 */
export const CLAUDE_BRIDGE = "claude-bridge";

/** Whether the model runs on claude-bridge, by its provider id. */
export function onClaudeBridge(model: { provider: string }): boolean {
	return model.provider === CLAUDE_BRIDGE;
}

const admits = (tier: AccessTier | undefined): boolean => {
	if (!tier) return false;
	const { everyone } = tier;
	if (everyone === true || (Array.isArray(everyone) && everyone.length > 0))
		return true;
	return (tier.identities?.length ?? 0) > 0 || (tier.roles?.length ?? 0) > 0;
};

/**
 * Why, by the configuration, a shared conversation of the host may have more than one person
 * speaking in it; undefined when the one owner alone does. More than one owner, rules that admit
 * admins or members, or a plugin's identity bound to a principal other than the primary owner's.
 */
export function configuredCrowd(
	rules: Pick<AccessRules, "owners" | "admins" | "members">,
	plugins: readonly Pick<RoundtablePlugin, "name" | "identities">[],
): string | undefined {
	if (rules.owners.length > 1)
		return `access.owners names ${rules.owners.length} owners`;
	for (const tier of ["admins", "members"] as const)
		if (admits(rules[tier]))
			return `access.${tier} admits people besides the owner`;
	const primary = rules.owners[0]?.principal;
	for (const plugin of plugins)
		for (const { identity, principal } of plugin.identities ?? [])
			if (principal !== undefined && principal !== primary)
				return `plugin ${plugin.name} binds ${identity} to principal ${principal}, not the owner's`;
	return undefined;
}

/**
 * Why, by the roles the host stores, such as those `roundtable principal grant` gives, a shared
 * conversation may have more than one person speaking in it; undefined when only the primary
 * owner holds a lasting role.
 */
export async function grantedCrowd(
	identity: Pick<IdentityService, "list" | "tierOf" | "owners">,
	primary: string,
): Promise<string | undefined> {
	const owners = await identity.owners();
	if (owners.length > 1)
		return `${owners.length} principals hold the owner role: ${owners.map((owner) => owner.id).join(", ")}`;
	for (const principal of await identity.list()) {
		if (principal.id === primary || principal.id === SYSTEM_PRINCIPAL) continue;
		const tier = await identity.tierOf(principal.id);
		if (tier) return `principal ${principal.id} holds the ${tier} role`;
	}
	return undefined;
}

/** Why claude-bridge may not serve a host whose shared conversations hold several people's memory. */
export function bridgeMemoryProblem(model: string, crowd: string): string {
	return `model ${model} runs on ${CLAUDE_BRIDGE}, and this host keeps each person's private memory while ${crowd}, so several people speak in its shared conversations. ${CLAUDE_BRIDGE} resumes the history Claude Code stored for a conversation, unfiltered, so one person's private memory would reach the next person who speaks there.`;
}

/** How to fix it. */
export const BRIDGE_MEMORY_FIX =
	"Use a model of another provider, set memory: false, or serve one person alone: one owner, and no admins or members.";

/** The refusal of claude-bridge on a host whose shared conversations hold several people's memory. */
export function bridgeMemoryError(model: string, crowd: string): ConfigError {
	return new ConfigError(
		`${bridgeMemoryProblem(model, crowd)} ${BRIDGE_MEMORY_FIX}`,
	);
}

/**
 * Refuses an agent's turn on a model of claude-bridge while the host refuses it, as `refusal`
 * says why, before the model is asked.
 */
export function refuseBridgeModel(
	agent: string,
	model: ModelRef | undefined,
	refusal: (() => string | undefined) | undefined,
): void {
	if (!model || !onClaudeBridge(model)) return;
	const why = refusal?.();
	if (why)
		throw new AgentRunError(
			`${agent}: ${bridgeMemoryError(formatModelRef(model), why).message}`,
		);
}
