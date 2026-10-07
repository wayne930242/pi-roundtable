import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { OWNER_TARGET } from "../agents/agent-claim.ts";
import type { SurfacePort } from "../contract/surface.ts";
import { scheduleCommands } from "../discord/schedule-commands.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import {
	ConfigError,
	DelegationError,
	ScheduleError,
} from "../domain/errors.ts";
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
import { precheckScriptHoldRule } from "../modules/schedules/precheck-tools.ts";
import { Scheduler } from "../modules/schedules/scheduler.ts";
import { schedulesExtension } from "../modules/schedules/schedules.ts";
import type { ErrorReporter } from "../ops/error-reporter.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import { splitReply } from "../presentation/reply-splitter.ts";
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
	/**
	 * Reports the process's own errors to a conversation, connected when the modules start; one
	 * that reports to an agent is the agent server's to connect.
	 */
	errorReporter?: ErrorReporter;
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
 * the turns nobody wrote. The delegator's running jobs join the shutdown drain. Without Discord
 * there are no owner's messages: no `notify_owner`, and a conversation no chat surface carries
 * can neither schedule nor delegate. Without the owner's background target no session gets the
 * schedule or delegation tools.
 */
export function modulesPlugin(options: ModulesOptions): RoundtablePlugin {
	const { owner } = options;
	// A conversation no chat surface carries posts its runs in the owner's messages, when there are any.
	const channelFor = async (
		channel: ChannelKey,
		surfaces: SurfacePort,
		ownerChannel: (() => Promise<ChannelKey>) | undefined,
		refused: (message: string) => Error,
	) => {
		if (surfaces.of(channel)) return channel;
		if (ownerChannel) return ownerChannel();
		throw refused(
			"this conversation has no chat surface to post a run in, and the host has no owner's messages to post it in instead",
		);
	};
	// Set up once the modules set up; the preflight reads it after every plugin linked.
	let reportsReach: (() => void) | undefined;
	return {
		name: "modules",
		provides: [BACKGROUND_TURNS, DELEGATION],
		preflight: () => reportsReach?.(),
		setup: ({
			conversations,
			services,
			logger,
			surfaces,
			sessions,
			toolTiers,
		}) => {
			const schedules = services.get(SCHEDULES);
			// Absent when a plugin list leaves the prechecks plugin out: then none can be attached.
			const prechecks = services.find(PRECHECKS);
			// Absent on a host without Discord: then there are no owner's messages and no threads.
			const discord = services.find(DISCORD);
			const connection = discord?.connection;
			const ownerChannel = connection
				? () => connection.ownerChannel()
				: undefined;
			// Another agent's channel, for schedule_list; asked when a tool runs, after the agent server set up.
			const agentChannelOf = (agent: string) =>
				services.get(AGENTS).team.channelOf(agent);
			const scheduleChannelFor = (channel: ChannelKey) =>
				channelFor(
					channel,
					surfaces,
					ownerChannel,
					(message) => new ScheduleError(message),
				);
			const delegateChannelFor = (channel: ChannelKey) =>
				channelFor(
					channel,
					surfaces,
					ownerChannel,
					(message) => new DelegationError(message),
				);
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
				...(discord ? { threads: discord.threads } : {}),
				logger,
			});
			services.provide(BACKGROUND_TURNS, background);
			services.provide(DELEGATION, delegator);
			// An agent session serves every speaker, so its tools name none.
			const served = (session: SessionContext) =>
				session.agent ? THE_SPEAKER : owner;
			// Schedules and delegated reports run as the owner's background turns; without a plugin
			// contributing that target, as on a host without the agent server, none could ever start,
			// so no session gets the tools. Read when a session is made, after every plugin set up.
			const ownerTurns = () =>
				conversations.target(OWNER_TARGET.name) !== undefined;
			// A reporter for an ops agent is the agent server's to connect.
			const reporter =
				options.errorReporter &&
				"conversation" in options.errorReporter.destination
					? options.errorReporter
					: undefined;
			if (reporter && "conversation" in reporter.destination) {
				const channel = reporter.destination.conversation;
				// A report that no surface can post, or that no conversation owns, would only be logged;
				// its report turn is the owner's background turn, which runs only where a claim takes one.
				reportsReach = () => {
					if (!surfaces.of(channel))
						throw new ConfigError(
							`config ops.conversation: no chat surface serves ${JSON.stringify(channel)}, so its error reports could never be posted. Name a conversation of a surface a plugin brings, or leave ops out.`,
						);
					if (!conversations.owns(channel))
						throw new ConfigError(
							`config ops.conversation: no plugin's conversations own ${JSON.stringify(channel)}, so nothing answers its error reports. Name a conversation a plugin's claim owns, or leave ops out.`,
						);
					if (!ownerTurns())
						throw new ConfigError(
							`config ops.conversation: no plugin contributes the "${OWNER_TARGET.name}" background target, so the report turns of ${JSON.stringify(channel)} could never run. Configure discord, whose agent server contributes it, add a plugin that contributes it, or leave ops out.`,
						);
					if (!conversations.takesBackground(channel))
						throw new ConfigError(
							`config ops.conversation: the claim that owns ${JSON.stringify(channel)} takes no background turns, so nothing answers its error reports. Name a conversation whose claim takes background turns, or leave ops out.`,
						);
				};
			}
			return {
				services: [
					{ name: "delegator", busy: () => delegator.runningChannels() },
					...(reporter
						? [
								{
									name: "error-reports",
									start: () =>
										reporter.connect({
											post: (channel, text) =>
												surfaces.sendReply(channel, {
													chunks: splitReply(text),
												}),
											turn: (channel, text) =>
												background.runErrorReport(channel, text),
											logger,
										}),
								},
							]
						: []),
				],
				// Saving a precheck script that calls a held tool waits for the owner, as the call would.
				holdRules: [
					precheckScriptHoldRule({
						prechecks: () => prechecks,
						holds: () => sessions().holds,
						tiers: () => toolTiers,
					}),
				],
				sessionTools: [
					...(connection
						? [fixed("notify", () => notifyExtension(connection, owner))]
						: []),
					fixed("schedules", (session) =>
						ownerTurns()
							? schedulesExtension(
									{
										store: schedules,
										owner: { id: owner.id, name: owner.name },
										channelFor: scheduleChannelFor,
										...(prechecks ? { prechecks } : {}),
										holds: () => sessions().holds,
									},
									session.homeChannel,
									served(session),
									session.agent ? agentChannelOf : undefined,
									session.speaker,
								)
							: null,
					),
					fixed("delegate", (session) =>
						ownerTurns()
							? delegateExtension(
									{
										delegator,
										owner: { id: owner.id, name: owner.name },
										channelFor: delegateChannelFor,
									},
									session.homeChannel,
									served(session),
									session.turnChannel,
									session.speaker,
								)
							: null,
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
		setup: ({ conversations, services, env, logger, surfaces, sessions }) => {
			const schedules = services.get(SCHEDULES);
			const prechecks = services.find(PRECHECKS);
			const scheduler = new Scheduler({
				store: schedules,
				runner: services.get(BACKGROUND_TURNS),
				...(prechecks ? { prechecks } : {}),
				holds: () => sessions().holds,
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
