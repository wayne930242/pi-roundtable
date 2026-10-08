import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
	AgentRuntime,
	AgentSessions,
	HeldActionStore,
	RuntimeDeps,
} from "../contract/runtime.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import type { InterimTextMode } from "../domain/interim.ts";
import type { OwnerIdentity } from "../identity.ts";
import type { PromptScope } from "../interactions/prompts.ts";
import { AGENT_BRIEF, EffortJudge } from "../judging/effort-judge.ts";
import type { ModelRef, ThinkingLevel } from "../models.ts";
import type { PluginContext, RoundtablePlugin } from "../plugin.ts";
import { RUNTIME } from "../services.ts";
import type { Speaker } from "../speakers.ts";
import { PendingConfirmationStore } from "./pending-confirmation-store.ts";
import { PiAgentRuntime } from "./pi-agent-runtime.ts";

/** The name of the runtime plugin, as `serviceStarted` events and the migration ledger name it. */
export const RUNTIME_PLUGIN = "runtime";

/**
 * Where the agent server hands the runtime its per-agent settings. The runtime is built before the
 * agent server sets up, so it reads them at each turn; on a host without the agent server they stay
 * unbound and no agent turn can run.
 */
export interface AgentSessionsSlot {
	/** The agent server's settings, or undefined while none are bound. */
	current(): AgentSessions | undefined;
	/** Called once, by the agent server's setup. */
	bind(sessions: AgentSessions): void;
}

export function agentSessionsSlot(): AgentSessionsSlot {
	let bound: AgentSessions | undefined;
	return {
		current: () => bound,
		bind: (sessions) => {
			if (bound)
				throw new Error(
					"the agent sessions are bound once, by the agent server",
				);
			bound = sessions;
		},
	};
}

export interface RuntimePluginOptions {
	/** Who the conversations serve, as prompts and tool results name them. */
	owner: OwnerIdentity & { id: string };
	/** Shared with the rest of the host, so logins refresh in one place. */
	modelRuntime: ModelRuntime;
	agentDir: string;
	dataDir: string;
	/** The assistant's model, and the thinking level the effort judge falls back to. */
	model: ModelRef;
	thinking: ThinkingLevel;
	/** How sure the effort judge must be before its answer is used. */
	judgeThreshold: number;
	/** The agent server's settings, bound when it sets up; without a slot no agent turn runs. */
	agents?: AgentSessionsSlot;
	/** Whether turns post the text they write before their final answer as they go; default "on". */
	interimText?: InterimTextMode;
	/** An intermediate text this long or longer is posted as an ordinary message; default 400. */
	interimPrimaryChars?: number;
}

/**
 * The runtime every conversation turn runs on, built once at setup and provided as `RUNTIME`: the
 * `runtime` provider slot's when a plugin fills it, Pi's otherwise. It keeps the held actions'
 * table, so a host without the agent server still holds and restores actions across a restart.
 */
export function runtimePlugin(
	options: RuntimePluginOptions,
	/** Opens the held actions' store; a test hands a stand-in, so the plugin sets up without a database. */
	openHeldActions: (
		context: Pick<PluginContext, "database">,
	) => Promise<HeldActionStore> = (context) =>
		PendingConfirmationStore.attach(context.database()),
): RoundtablePlugin {
	let runtime: AgentRuntime | undefined;
	return {
		name: RUNTIME_PLUGIN,
		migrations: PendingConfirmationStore.migrations(),
		provides: [RUNTIME],
		preflight: async () => {
			await runtime?.preflight?.();
		},
		setup: async (context) => {
			const { logger, providers } = context;
			const heldActions = await openHeldActions(context);
			const prompts = (channel: ChannelKey, scope?: PromptScope | Speaker) =>
				context.surfaces.prompts(channel, scope);
			const agents = () => options.agents?.current();
			const running: AgentRuntime = providers.filled.has("runtime")
				? providers.runtime(
						runtimeDeps({
							logger,
							env: context.env,
							owner: { id: options.owner.id, name: options.owner.name },
							sessions: context.sessions,
							toolTiers: context.toolTiers,
							prompts,
							agents,
							confirmations: heldActions,
							judge: providers.judge,
						}),
					)
				: new PiAgentRuntime({
						owner: options.owner,
						sessions: context.sessions,
						agentDir: options.agentDir,
						modelRuntime: options.modelRuntime,
						dataDir: options.dataDir,
						model: options.model,
						thinking: options.thinking,
						effort: new EffortJudge({
							judge: providers.judge,
							brief: AGENT_BRIEF,
							fallback: options.thinking,
							threshold: options.judgeThreshold,
							logger,
						}),
						confirmations: heldActions,
						toolTiers: context.toolTiers,
						get agents() {
							return agents();
						},
						prompts,
						logger,
						...(options.interimText
							? { interimText: options.interimText }
							: {}),
						...(options.interimPrimaryChars
							? { interimPrimaryChars: options.interimPrimaryChars }
							: {}),
					});
			runtime = running;
			context.services.provide(RUNTIME, running);
			return {
				services: [{ name: "runtime", stop: () => running.dispose?.() }],
			};
		},
	};
}

/** The deps a runtime provider gets, with `agents` read when asked, after the agent server bound it. */
function runtimeDeps(
	deps: Omit<RuntimeDeps, "agents"> & {
		agents: () => AgentSessions | undefined;
	},
): RuntimeDeps {
	const { agents, ...rest } = deps;
	return {
		...rest,
		get agents() {
			return agents();
		},
	};
}
