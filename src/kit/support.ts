// Supporting data types for the service and helper contracts.

export type {
	AgentModels,
	AgentTurnRunner,
} from "../core/agents/agent-ports.ts";
export type { Backlog, GroupMessage } from "../core/agents/agent-rules.ts";

// Deprecated here, removed from `pi-roundtable/kit` in 1.0: Discord's agent guild internals, which
// `pi-roundtable/discord` exports then (an entry holds a name once until 1.0). The aliases carry
// the tag, so the same types stay unmarked where `pi-roundtable/discord` hands them out.
import type * as AgentChannelTypes from "../core/contract/agent-channels.ts";

/** @deprecated Since 0.46 a Discord internal: its export from `pi-roundtable/kit` goes away in 1.0, and `pi-roundtable/discord` exports it then. */
export type AgentCategory = AgentChannelTypes.AgentCategory;

/** @deprecated Since 0.46 a Discord internal: its export from `pi-roundtable/kit` goes away in 1.0, and `pi-roundtable/discord` exports it then. */
export type AgentChannels = AgentChannelTypes.AgentChannels;

/** @deprecated Since 0.46 a Discord internal: its export from `pi-roundtable/kit` goes away in 1.0, and `pi-roundtable/discord` exports it then. */
export type AgentPost = AgentChannelTypes.AgentPost;

/** @deprecated Since 0.46 a Discord internal: its export from `pi-roundtable/kit` goes away in 1.0, and `pi-roundtable/discord` exports it then. */
export type CategoryLayout = AgentChannelTypes.CategoryLayout;

/** @deprecated Since 0.46 a Discord internal: its export from `pi-roundtable/kit` goes away in 1.0, and `pi-roundtable/discord` exports it then. */
export type ChannelMessage = AgentChannelTypes.ChannelMessage;

/** @deprecated Since 0.46 a Discord internal: its export from `pi-roundtable/kit` goes away in 1.0, and `pi-roundtable/discord` exports it then. */
export type DashboardBoard = AgentChannelTypes.DashboardBoard;

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
