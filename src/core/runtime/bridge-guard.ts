import type { ContextWithSystemEvent } from "@earendil-works/pi-coding-agent";
import type { AgentSessions } from "../contract/runtime.ts";
import { ConfigError } from "../domain/errors.ts";
import type { AccessRules, AccessTier } from "../identity/access-policy.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import { SYSTEM_PRINCIPAL } from "../identity/principal-store.ts";
import { formatModelRef, type ModelRef, parseModelRef } from "../models.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import { hidesPrivateExchange } from "./extensions/private-memory.ts";

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

/**
 * Whether the tier admits someone besides the owners: everyone, a role, which anyone may hold, or
 * an identity that is not already an owner's, since an owner listed again is still one person.
 */
const admits = (
	tier: AccessTier | undefined,
	owners: ReadonlySet<string>,
): boolean => {
	if (!tier) return false;
	const { everyone } = tier;
	if (everyone === true || (Array.isArray(everyone) && everyone.length > 0))
		return true;
	return (
		(tier.identities ?? []).some((identity) => !owners.has(identity)) ||
		(tier.roles?.length ?? 0) > 0
	);
};

/**
 * Why, by the configuration, a shared conversation of the host may have more than one person
 * speaking in it; undefined when the one owner alone does. More than one owner, rules that admit
 * admins or members besides the owner's own identities, or a plugin's identity bound to a
 * principal other than the primary owner's.
 */
export function configuredCrowd(
	rules: Pick<AccessRules, "owners" | "admins" | "members">,
	plugins: readonly Pick<RoundtablePlugin, "name" | "identities">[],
): string | undefined {
	if (rules.owners.length > 1)
		return `access.owners names ${rules.owners.length} owners`;
	const owners = new Set(rules.owners.flatMap((owner) => owner.identities));
	for (const tier of ["admins", "members"] as const)
		if (admits(rules[tier], owners))
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
async function grantedCrowd(
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
	return `model ${model} runs on ${CLAUDE_BRIDGE}, and this host keeps each person's private memory while ${crowd}. ${CLAUDE_BRIDGE} resumes the history Claude Code stored for a conversation, unfiltered, so one person's private memory could reach another reader. Shared turns with inaccessible private exchanges are refused; untagged legacy memory results count as the primary owner's for this check. Private information repeated in public replies, other untagged tools, or existing summaries remains a risk.`;
}

/** How to fix it. */
export const BRIDGE_MEMORY_FIX =
	"Use a model of another provider, set memory: false, or keep each conversation's private exchanges visible to its readers (start a fresh conversation before sharing old owner history).";

/** The refusal of claude-bridge on a host whose shared conversations hold several people's memory. */
export function bridgeMemoryError(model: string, crowd: string): ConfigError {
	return new ConfigError(
		`${bridgeMemoryProblem(model, crowd)} ${BRIDGE_MEMORY_FIX}`,
	);
}

/**
 * Why a shared turn may not run on the model it asks, as `bridgeRefusal` says at the turn;
 * undefined when it may. The model is the agent's own for an agent's turn, the host's otherwise.
 */
export async function bridgeTurnRefusal(
	agent: string | undefined,
	options: {
		model: ModelRef;
		agents?: Pick<AgentSessions, "modelOf"> | undefined;
		memory?: boolean;
		owner: { id: string };
	},
	history: {
		messages: ContextWithSystemEvent["messages"];
		reader: string | undefined;
	},
): Promise<string | undefined> {
	const model =
		agent === undefined
			? options.model
			: options.agents && parseModelRef(options.agents.modelOf(agent).model);
	if (!options.memory || !model || !onClaudeBridge(model)) return undefined;
	const reader =
		history.reader === SYSTEM_PRINCIPAL ? options.owner.id : history.reader;
	if (
		!hidesPrivateExchange(history.messages, {
			shared: true,
			reader,
			legacyOwner: options.owner.id,
		})
	)
		return undefined;
	const why =
		"this conversation's raw history holds a private exchange the current reader may not see";
	const message = bridgeMemoryError(formatModelRef(model), why).message;
	return agent === undefined ? message : `${agent}: ${message}`;
}

/**
 * Why claude-bridge may not serve the host now, read at each turn: the configuration's crowd, or
 * the roles the host stores as they are now, so one granted after the boot counts at once.
 * Undefined while one person alone may speak, or the host keeps no memory.
 */
export function liveBridgeRefusal(options: {
	memory: boolean | undefined;
	crowd: string | undefined;
	identity: () =>
		| Pick<IdentityService, "list" | "tierOf" | "owners">
		| undefined;
	primary: string;
}): () => Promise<string | undefined> {
	return async () => {
		if (!options.memory) return undefined;
		if (options.crowd) return options.crowd;
		const identity = options.identity();
		return identity && (await grantedCrowd(identity, options.primary));
	};
}
