import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SurfacePort } from "../contract/surface.ts";
import { scheduleCommands } from "../discord/schedule-commands.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import { messages } from "../i18n/index.ts";
import type { OwnerIdentity } from "../identity.ts";
import type { ModelRef, ThinkingLevel } from "../models.ts";
import { ConversationBackgroundTurns } from "../modules/background/background-turns.ts";
import { delegateExtension } from "../modules/delegation/delegate.ts";
import {
	DefaultDelegator,
	type DelegationWorker,
} from "../modules/delegation/delegator.ts";
import { WebResearchWorker } from "../modules/delegation/web-research-worker.ts";
import { notifyExtension } from "../modules/notify/notify.ts";
import { Scheduler } from "../modules/schedules/scheduler.ts";
import { schedulesExtension } from "../modules/schedules/schedules.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import {
	AGENTS,
	BACKGROUND_TURNS,
	DELEGATION,
	PRECHECKS,
	SCHEDULES,
} from "../services.ts";
import type { SessionContext } from "../sessions.ts";
import { DELEGATE_TOOL } from "../shared/delegate-tool.ts";
import { SCHEDULE_TOOLS } from "../shared/schedule-tools.ts";
import { THE_SPEAKER, type Tier } from "../speakers.ts";
import { DISCORD } from "./discord.ts";
import { fixed } from "./session-tool.ts";

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
}

/**
 * Admins schedule and delegate; every speaker may list schedules and use the web tools the
 * delegated worker and pi-web-access give. Notifying the owner stays with the owner.
 */
const MODULE_TIERS: Readonly<Record<string, Tier>> = {
	...Object.fromEntries(
		[...SCHEDULE_TOOLS, DELEGATE_TOOL].map((tool) => [tool, "admin" as const]),
	),
	schedule_list: "member",
	web_search: "member",
	fetch_content: "member",
	get_search_content: "member",
};

/**
 * The owner's modules: notifications, schedules, and delegated tasks, each a session tool, and
 * the turns nobody wrote. The delegator's running jobs join the shutdown drain.
 */
export function modulesPlugin(options: ModulesOptions): RoundtablePlugin {
	const { owner } = options;
	// Outside the agent server a conversation has no channel of its own to post a run in.
	const channelFor = async (
		channel: ChannelKey,
		surfaces: SurfacePort,
		ownerChannel: () => Promise<ChannelKey>,
	) => (surfaces.of(channel) ? channel : ownerChannel());
	return {
		name: "modules",
		provides: [BACKGROUND_TURNS, DELEGATION],
		setup: ({ conversations, services, logger, surfaces }) => {
			const schedules = services.get(SCHEDULES);
			// Absent when a plugin list leaves the prechecks plugin out: then none can be attached.
			const prechecks = services.find(PRECHECKS);
			const discord = services.get(DISCORD);
			const { connection } = discord;
			// Another agent's channel, for schedule_list; asked when a tool runs, after the agent server set up.
			const agentChannelOf = (agent: string) =>
				services.get(AGENTS).team.channelOf(agent);
			const ownerChannelFor = (channel: ChannelKey) =>
				channelFor(channel, surfaces, () => connection.ownerChannel());
			const background = new ConversationBackgroundTurns({
				conversations,
				system: { id: "assistant", name: options.assistant },
				logger,
			});
			const delegator = new DefaultDelegator({
				worker:
					options.delegation.worker ??
					new WebResearchWorker({
						modelRuntime: options.modelRuntime,
						agentDir: options.agentDir,
						workDir: join(options.dataDir, "delegate"),
						model: options.delegation.model,
						thinking: options.delegation.thinking,
					}),
				targets: (name) => conversations.target(name),
				deliver: (job, outcome) => background.runDelegated(job, outcome),
				threads: discord.threads,
				logger,
			});
			services.provide(BACKGROUND_TURNS, background);
			services.provide(DELEGATION, delegator);
			// An agent session serves every speaker, so its tools name none.
			const served = (session: SessionContext) =>
				session.agent ? THE_SPEAKER : owner;
			return {
				services: [
					{ name: "delegator", busy: () => delegator.runningChannels() },
				],
				sessionTools: [
					fixed("notify", () => notifyExtension(connection, owner)),
					fixed("schedules", (session) =>
						schedulesExtension(
							{
								store: schedules,
								owner: { id: owner.id, name: owner.name },
								channelFor: ownerChannelFor,
								...(prechecks ? { prechecks } : {}),
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
				],
				toolTiers: MODULE_TIERS,
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
		setup: ({ conversations, services, env, logger, surfaces }) => {
			const schedules = services.get(SCHEDULES);
			const prechecks = services.find(PRECHECKS);
			const scheduler = new Scheduler({
				store: schedules,
				runner: services.get(BACKGROUND_TURNS),
				...(prechecks ? { prechecks } : {}),
				// The bot's own message: the surface drops it, so it starts no turn.
				notify: (schedule, note) =>
					surfaces.sendReply(schedule.channel, {
						chunks: [
							messages().schedulePrecheckNote(
								schedule.id,
								schedule.title,
								note,
							),
						],
					}),
				logger,
			});
			// Without Discord there are no schedule commands; the scheduler still fires.
			const discord = services.find(DISCORD);
			discord?.commands.add(
				scheduleCommands(
					discord.guard,
					schedules,
					(target) => conversations.target(target)?.label(env.locale) ?? target,
				),
			);
			return {
				services: [
					{
						name: "scheduler",
						start: () => scheduler.start(),
						stop: () => scheduler.stop(),
					},
				],
			};
		},
	};
}
