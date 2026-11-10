// Supporting data types for the service and helper contracts.

export type {
	AgentModels,
	AgentTurnRunner,
} from "../core/agents/agent-ports.ts";
export type { Backlog, GroupMessage } from "../core/agents/agent-rules.ts";
// Deprecated here, removed from `pi-roundtable/kit` in 1.0: Discord's agent guild internals,
// which `pi-roundtable/discord` exports too.
export type {
	AgentCategory,
	AgentChannels,
	AgentPost,
	CategoryLayout,
	ChannelMessage,
	DashboardBoard,
} from "../core/contract/agent-channels.ts";
export type {
	EffortPolicy,
	EffortRequest,
	EffortRule,
	ThinkingPicker,
} from "../core/domain/models.ts";
export type { Notifier, OwnerNotifier } from "../core/domain/ports.ts";
export type { SpeakerFacts, SpeakerPolicy } from "../core/identity/speakers.ts";
export type { DelegationWorker } from "../core/modules/delegation/delegator.ts";
export type { AgentChannelLookup } from "../core/modules/schedules/schedules.ts";
export type { AgentOps } from "../core/plugin-api/agent-ops.ts";
export type { AssistantLike } from "../core/shared/session-messages.ts";
export type { ThreadHost } from "../core/threads/dispatch-threads.ts";
