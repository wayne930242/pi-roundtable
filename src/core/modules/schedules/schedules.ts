import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ChannelKey } from "../../domain/conversation.ts";
import { ScheduleError } from "../../domain/errors.ts";
import type { HoldCheck } from "../../holds.ts";
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
import { PERSONAL_TARGET } from "../background/personal-target.ts";
import type { PrecheckRegistry } from "./prechecks.ts";
import { callScheduleTool } from "./schedule-tools.ts";

export interface OwnerSchedules {
	store: ScheduleStore;
	/**
	 * The chat channel a conversation's schedules belong to: itself, or the owner's direct
	 * messages for a conversation no chat surface carries, where a run could not be posted; asked
	 * with the asker's principal, and throws ScheduleError when their runs could go nowhere.
	 */
	channelFor: (channel: ChannelKey, principalId: string) => Promise<ChannelKey>;
	/** The host's prechecks a schedule may name, and the runner of scripts it may carry; without them, none can be attached. */
	prechecks?: Pick<PrecheckRegistry, "get" | "list"> &
		Partial<Pick<PrecheckRegistry, "scriptRunner">>;
	/** The host's hold rules, which mark a saved script's approved tools. */
	holds?: () => HoldCheck;
	/**
	 * Whose the conversation is, read when a tool runs: in a private one the speaker sees only
	 * their own schedules. Without it, every schedule of the channel, as in a shared one.
	 */
	visibility?: () => Promise<"private" | "shared">;
	/** The principal a schedule's creator id stands for, such as the primary owner for 0.8's `remote-mcp`. */
	principalOf?: (createdById: string) => Promise<string | undefined>;
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
 * Registers the schedule tools for one conversation; a schedule's runs speak for the person whose
 * turn set it up, and in a turn nobody is named for the tools refuse. With `agents`,
 * schedule_list can also read another agent's schedules.
 */
export function schedulesExtension(
	schedules: OwnerSchedules,
	channel: ChannelKey,
	identity: OwnerIdentity,
	agents?: AgentChannelLookup,
	/** The person the running turn is for; their schedules run at their tier. */
	speaker: () => Speaker | undefined = () => undefined,
): ExtensionFactory {
	const { store, channelFor, prechecks, holds, visibility, principalOf } =
		schedules;
	const defs = scheduleToolSpecs({
		locale: activeLocale(),
		timeZone: timeZone(),
		precheckScripts: prechecks?.scriptRunner?.() !== undefined,
	}).map((base) => {
		const spec = agents ? withAgentOption(base) : base;
		return {
			...spec,
			run: async (input: ToolInput) => {
				const author = speaker();
				if (!author)
					throw new ScheduleError(
						"schedules are kept only in a turn someone is named for, whose schedules they are",
					);
				const peer =
					agents && typeof input.agent === "string" && input.agent
						? agents(input.agent)
						: undefined;
				const target = peer ?? (await channelFor(channel, author.principalId));
				const answer = await callScheduleTool(
					{
						store,
						channel: target,
						target: PERSONAL_TARGET,
						author: {
							principalId: author.principalId,
							id: author.id,
							name: author.name,
							tier: author.tier,
						},
						now: new Date(),
						...(prechecks ? { prechecks } : {}),
						...(holds ? { holds } : {}),
						...(visibility ? { visibility: await visibility() } : {}),
						...(principalOf ? { principalOf } : {}),
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
