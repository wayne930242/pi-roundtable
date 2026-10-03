import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { OWNER_TARGET } from "../../agents/agent-claim.ts";
import type { ChannelKey } from "../../domain/conversation.ts";
import { ScheduleError } from "../../domain/errors.ts";
import { activeLocale } from "../../i18n/index.ts";
import type { OwnerIdentity } from "../../identity.ts";
import {
	type ToolInput,
	textToolsExtension,
} from "../../runtime/text-tools.ts";
import type { ScheduleStore } from "../../services.ts";
import {
	type ScheduleToolSpec,
	scheduleToolSpecs,
} from "../../shared/schedule-tools.ts";
import type { Speaker } from "../../speakers.ts";
import { timeZone } from "../../time.ts";
import type { PrecheckRegistry } from "./prechecks.ts";
import { callScheduleTool } from "./schedule-tools.ts";

export interface OwnerSchedules {
	store: ScheduleStore;
	owner: { id: string; name: string };
	/**
	 * The chat channel a conversation's schedules belong to: itself, or the owner's direct
	 * messages for a conversation no chat surface carries, where a run could not be posted.
	 */
	channelFor: (channel: ChannelKey) => Promise<ChannelKey>;
	/** The host's prechecks a schedule may name, and the runner of scripts it may carry; without them, none can be attached. */
	prechecks?: Pick<PrecheckRegistry, "get" | "list"> &
		Partial<Pick<PrecheckRegistry, "scriptRunner">>;
}

/** Finds another agent's channel, for reading its schedules; throws ScheduleError when there is none. */
export type AgentChannelLookup = (agent: string) => ChannelKey;

/** schedule_list for agents: an optional agent name reads that agent's schedules instead. */
function withAgentOption(spec: ScheduleToolSpec): ScheduleToolSpec {
	if (spec.name !== "schedule_list") return spec;
	return {
		...spec,
		description: `${spec.description} Give agent to read another agent's schedules instead; you can change only your own, so ask that agent to change its.`,
		parameters: Type.Object({
			id: Type.Optional(Type.Integer({ description: "Schedule id." })),
			agent: Type.Optional(
				Type.String({ description: "Another agent's name, from agent_list." }),
			),
		}),
	};
}

/**
 * Registers the schedule tools for one owner conversation; its runs speak for the owner. With
 * `agents`, schedule_list can also read another agent's schedules.
 */
export function schedulesExtension(
	schedules: OwnerSchedules,
	channel: ChannelKey,
	identity: OwnerIdentity,
	agents?: AgentChannelLookup,
	/** The person the running turn is for; their schedules run at their tier. */
	speaker: () => Speaker | undefined = () => undefined,
): ExtensionFactory {
	const { store, owner, channelFor, prechecks } = schedules;
	const defs = scheduleToolSpecs({
		locale: activeLocale(),
		timeZone: timeZone(),
		precheckScripts: prechecks?.scriptRunner?.() !== undefined,
	}).map((base) => {
		const spec = agents ? withAgentOption(base) : base;
		return {
			...spec,
			run: async (input: ToolInput) => {
				const peer =
					agents && typeof input.agent === "string" && input.agent
						? agents(input.agent)
						: undefined;
				const target = peer ?? (await channelFor(channel));
				const answer = await callScheduleTool(
					{
						store,
						channel: target,
						target: OWNER_TARGET,
						author: speaker() ?? owner,
						now: new Date(),
						...(prechecks ? { prechecks } : {}),
					},
					spec.name,
					input,
				);
				if (peer) return `Agent ${String(input.agent)}'s channel:\n${answer}`;
				if (target === channel) return answer;
				return `${answer}\n(These are the schedules of ${identity.name}'s Discord direct messages; their runs are posted there.)`;
			},
		};
	});
	return textToolsExtension(defs, ScheduleError);
}
