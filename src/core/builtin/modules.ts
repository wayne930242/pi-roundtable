import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { scheduleCommands } from "../discord/schedule-commands.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import type { OwnerIdentity } from "../identity.ts";
import type { ModelRef, ThinkingLevel } from "../models.ts";
import { BackgroundTurns } from "../modules/background/background-turns.ts";
import { delegateExtension } from "../modules/delegation/delegate.ts";
import {
	type DelegationWorker,
	Delegator,
} from "../modules/delegation/delegator.ts";
import { SolWorker } from "../modules/delegation/sol-worker.ts";
import { discordAdminExtension } from "../modules/discord-admin/discord-admin.ts";
import { ownerMemoryExtension } from "../modules/memory/owner-memory.ts";
import { notifyExtension } from "../modules/notify/notify.ts";
import { Scheduler } from "../modules/schedules/scheduler.ts";
import {
	type AgentChannelLookup,
	schedulesExtension,
} from "../modules/schedules/schedules.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import type {
	SessionContext,
	SessionTool,
	SessionToolSnapshot,
} from "../sessions.ts";
import { THE_SPEAKER } from "../speakers.ts";

export interface ModulesOptions {
	/** Who the tools serve in the owner's own sessions. */
	owner: OwnerIdentity & { id: string };
	/** The name a turn the process itself starts is written by. */
	assistant: string;
	/** Shared with the rest of the host, so logins refresh in one place. */
	modelRuntime: ModelRuntime;
	agentDir: string;
	dataDir: string;
	/** The model that runs delegated tasks, or a worker of your own that replaces it. */
	delegation: {
		model: ModelRef;
		thinking: ThinkingLevel;
		worker?: DelegationWorker;
	};
	/** Another agent's channel, for reading its schedules; throws ScheduleError when unknown. */
	agentChannelOf?: AgentChannelLookup;
}

/** A session tool whose extension never changes. */
function fixed(
	name: string,
	factory: SessionToolSnapshot["factory"],
): SessionTool {
	return { name, phase: "tools", snapshot: () => ({ revision: 0, factory }) };
}

/**
 * The owner's modules: memory, notifications, schedules, delegated tasks, and Discord reading
 * and management, each a session tool, and the turns nobody wrote. The delegator's running jobs
 * join the shutdown drain.
 */
export function modulesPlugin(options: ModulesOptions): RoundtablePlugin {
	const { owner, agentChannelOf } = options;
	// Outside the agent server a conversation has no channel of its own to post a run in.
	const channelFor = async (
		channel: ChannelKey,
		surfaceOwnerChannel: () => Promise<ChannelKey>,
	) => (channel.startsWith("discord:") ? channel : surfaceOwnerChannel());
	return {
		name: "modules",
		setup: ({ conversations, core, logger }) => {
			const { stores, discord } = core;
			const { surface } = discord;
			const ownerChannelFor = (channel: ChannelKey) =>
				channelFor(channel, () => surface.ownerChannel());
			const background = new BackgroundTurns({
				conversations,
				system: { id: "assistant", name: options.assistant },
				logger,
			});
			const delegator = new Delegator({
				worker:
					options.delegation.worker ??
					new SolWorker({
						modelRuntime: options.modelRuntime,
						agentDir: options.agentDir,
						workDir: join(options.dataDir, "delegate"),
						model: options.delegation.model,
						thinking: options.delegation.thinking,
					}),
				deliver: (job, outcome) => background.runDelegated(job, outcome),
				threads: discord.threads,
				logger,
			});
			core.provide("background", background);
			core.provide("delegator", delegator);
			// An agent session serves every speaker, so its tools name none.
			const served = (session: SessionContext) =>
				session.agent ? THE_SPEAKER : owner;
			return {
				services: [
					{ name: "delegator", busy: () => delegator.runningChannels() },
				],
				sessionTools: [
					fixed("owner-memory", (session) =>
						ownerMemoryExtension(
							stores.memory,
							served(session),
							// The owner's own chats have one speaker; the agent server's have several.
							session.agent ? session.speaker : undefined,
						),
					),
					fixed("notify", () => notifyExtension(surface, owner)),
					fixed("schedules", (session) =>
						schedulesExtension(
							{
								store: stores.schedules,
								owner: { id: owner.id, name: owner.name },
								channelFor: ownerChannelFor,
							},
							session.homeChannel,
							served(session),
							session.agent ? agentChannelOf : undefined,
							session.speaker,
						),
					),
					fixed("delegate", (session) =>
						delegateExtension(
							{
								delegator,
								owner: { id: owner.id, name: owner.name },
								channelFor: ownerChannelFor,
							},
							session.homeChannel,
							served(session),
							session.turnChannel,
							session.speaker,
						),
					),
					fixed("discord-admin", () =>
						discordAdminExtension(surface.ownerDiscord(), owner),
					),
				],
			};
		},
	};
}

/**
 * Fires the schedules that fall due, and adds their slash commands. Registered apart from the
 * modules so a plugin list can start the scheduler after everything a fired schedule reaches.
 */
export function schedulerPlugin(): RoundtablePlugin {
	return {
		name: "schedules",
		setup: ({ core, logger }) => {
			const scheduler = new Scheduler({
				store: core.stores.schedules,
				runner: core.background,
				logger,
			});
			return {
				services: [
					{
						name: "scheduler",
						start: () => scheduler.start(),
						stop: () => scheduler.stop(),
					},
				],
				interactions: [
					scheduleCommands(core.discord.guard, core.stores.schedules),
				],
			};
		},
	};
}
