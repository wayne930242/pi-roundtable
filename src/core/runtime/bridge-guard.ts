import type {
	AgentSession,
	ContextWithSystemEvent,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessions } from "../contract/runtime.ts";
import { AgentRunError, ConfigError } from "../domain/errors.ts";
import type { AccessRules, AccessTier } from "../identity/access-policy.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import { SYSTEM_PRINCIPAL } from "../identity/principal-store.ts";
import {
	formatModelRef,
	type ModelRef,
	parseModelRef,
	type ThinkingSetting,
} from "../models.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import { hidesPrivateExchange } from "./extensions/private-memory.ts";
import { SCOPE_ENTRY } from "./session-scope.ts";

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
	return `model ${model} runs on ${CLAUDE_BRIDGE}, and this host keeps each person's private memory while ${crowd}. ${CLAUDE_BRIDGE} resumes the history Claude Code stored for a conversation, unfiltered, so one person's private memory could reach another reader. Shared turns with inaccessible private exchanges are refused; untagged legacy memory results count as the primary owner's for this check. Private information in retained prompts/reasoning, public replies, other untagged tools, or existing summaries remains a risk.`;
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

export interface AgentModelSettings {
	model: string;
	thinking: ThinkingSetting;
}

/** Copy the turn's selected model/settings once: checking and using separate reads can race a switch. */
export function chosenAgentModel(
	agent: string | undefined,
	options: { agents?: Pick<AgentSessions, "modelOf"> },
): AgentModelSettings | undefined {
	return agent !== undefined && options.agents
		? { ...options.agents.modelOf(agent) }
		: undefined;
}

/** Apply exactly the model snapshot the guard checked, never a later live settings read. */
export async function useChosenAgentModel(
	session: AgentSession,
	modelRuntime: Pick<ModelRuntime, "getModel">,
	name: string,
	chosen: AgentModelSettings | undefined,
): Promise<ThinkingSetting> {
	if (!chosen)
		throw new ConfigError("agent turns need the runtime's agents option");
	const { model, thinking } = chosen;
	const ref = parseModelRef(model);
	if (
		session.model?.provider !== ref?.provider ||
		session.model?.id !== ref?.id
	) {
		const resolved = ref && modelRuntime.getModel(ref.provider, ref.id);
		if (!resolved)
			throw new AgentRunError(
				`${name}'s model ${model} is not available on this host`,
			);
		await session.setModel(resolved);
	}
	return thinking;
}

interface BridgeHistory {
	messages: ContextWithSystemEvent["messages"];
	reader: string | undefined;
	/** The persisted branch retains exchanges removed from the active context by compaction. */
	sessionManager?: Pick<SessionManager, "getBranch">;
}

/** Only results recorded before the first 0.9 scope marker inherit legacy owner attribution. */
function hidesBridgeHistory(
	history: BridgeHistory,
	reader: string | undefined,
	primary: string,
): boolean {
	const view = { shared: true, reader };
	const branch = history.sessionManager?.getBranch();
	if (!branch)
		return hidesPrivateExchange(history.messages, {
			...view,
			legacyOwner: primary,
		});
	const scope = branch.findIndex(
		(entry) => entry.type === "custom" && entry.customType === SCOPE_ENTRY,
	);
	const cut = scope < 0 ? branch.length : scope;
	const messagesOf = (entries: typeof branch) =>
		entries.flatMap((entry) =>
			entry.type === "message" ? [entry.message] : [],
		);
	return (
		hidesPrivateExchange(messagesOf(branch.slice(0, cut)), {
			...view,
			legacyOwner: primary,
		}) || hidesPrivateExchange(messagesOf(branch.slice(cut)), view)
	);
}

/**
 * Why raw private history prevents a shared turn from running on its selected bridge model;
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
	history: BridgeHistory,
	chosen?: AgentModelSettings,
): Promise<string | undefined> {
	const model =
		agent === undefined
			? options.model
			: parseModelRef(
					chosen?.model ?? options.agents?.modelOf(agent).model ?? "",
				);
	if (options.memory === false || !model || !onClaudeBridge(model))
		return undefined;
	const reader =
		history.reader === SYSTEM_PRINCIPAL ? options.owner.id : history.reader;
	if (!hidesBridgeHistory(history, reader, options.owner.id)) return undefined;
	const why =
		"this conversation's raw history holds a private exchange the current reader may not see";
	const message = bridgeMemoryError(formatModelRef(model), why).message;
	return agent === undefined ? message : `${agent}: ${message}`;
}

/**
 * Why startup should warn about claude-bridge: the configuration's crowd, or
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
