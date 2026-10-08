import { join } from "node:path";
import type {
	ExtensionFactory,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { scheduleCommands } from "../discord/schedule-commands.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import {
	ConfigError,
	DelegationError,
	ScheduleError,
} from "../domain/errors.ts";
import { messages } from "../i18n/index.ts";
import { legacyPrincipalsOf } from "../identity/identity-view.ts";
import type { OwnerIdentity } from "../identity.ts";
import type { ModelRef, ThinkingLevel } from "../models.ts";
import { ConversationBackgroundTurns } from "../modules/background/background-turns.ts";
import {
	type PerPrincipalLimits,
	personalTarget,
} from "../modules/background/personal-target.ts";
import { delegateExtension } from "../modules/delegation/delegate.ts";
import {
	DefaultDelegator,
	type DelegationWorker,
} from "../modules/delegation/delegator.ts";
import { WebResearchWorker } from "../modules/delegation/web-research-worker.ts";
import { sessionNotify } from "../modules/notify/session-notify.ts";
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
	IDENTITY,
	PRECHECKS,
	SCHEDULES,
} from "../services.ts";
import type { SessionContext } from "../sessions.ts";
import { DELEGATE_TOOL } from "../shared/delegate-tool.ts";
import { SCHEDULE_TOOLS } from "../shared/schedule-tools.ts";
import type { Tier } from "../speakers.ts";
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
	/**
	 * Each person's limits across their conversations, which the personal target holds them to;
	 * unset, only each conversation's, as in 0.8.
	 */
	perPrincipal?: PerPrincipalLimits;
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
 * The modules: notifications, schedules, and delegated tasks, each a session tool, and the turns
 * nobody wrote. The delegator's running jobs join the shutdown drain. `notify` sends through the
 * plugins' direct channels, so with none there is no notify. A conversation no chat surface carries
 * schedules and delegates only when recorded private, into its creator's reachable,
 * background-capable direct channel. It
 * contributes `PERSONAL_TARGET`, with the per-person limits given, whose turns the schedules and
 * delegated reports are, and a session whose conversation's claim takes no background turns gets
 * neither tool.
 */
export function modulesPlugin(options: ModulesOptions): RoundtablePlugin {
	const { owner } = options;
	const personal = personalTarget(options.perPrincipal);
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
			directChannels,
		}) => {
			const schedules = services.get(SCHEDULES);
			// Absent when a plugin list leaves the prechecks plugin out: then none can be attached.
			const prechecks = services.find(PRECHECKS);
			// Absent on a host without Discord: then there are no threads.
			const discord = services.find(DISCORD);
			// Another agent's channel, for schedule_list; asked when a tool runs, after the agent server set up.
			const agentChannelOf = (agent: string) =>
				services.get(AGENTS).team.channelOf(agent);
			// A conversation no chat surface carries keeps its runs in the creator's direct messages, where
			// a claim must take them; anyone's elsewhere would run in a conversation that is not theirs.
			const channelFor = async (
				channel: ChannelKey,
				principalId: string,
				refused: (message: string) => Error,
			) => {
				if (surfaces.of(channel)) return channel;
				const reached = await directChannels.reach(principalId);
				if (!reached)
					throw refused(
						"this conversation has no chat surface to post a run in, and you have no direct channel on this host to post it in instead",
					);
				if (!conversations.takesBackground(reached.channel))
					throw refused(
						`this conversation has no chat surface to post a run in, and nothing here takes background turns in your ${reached.provider.name} direct messages, where it would go instead`,
					);
				return reached.channel;
			};
			const scheduleChannelFor = (channel: ChannelKey, principalId: string) =>
				channelFor(channel, principalId, (m) => new ScheduleError(m));
			const delegateChannelFor = (channel: ChannelKey, principalId: string) =>
				channelFor(channel, principalId, (m) => new DelegationError(m));
			const identity = services.find(IDENTITY);
			const background = new ConversationBackgroundTurns({
				conversations,
				system: { id: "assistant", name: options.assistant },
				...(identity ? { principalOf: legacyPrincipalsOf(identity) } : {}),
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
			// Schedules and delegated reports run as background turns in the conversation, or, for one
			// no chat surface carries, in the creator's direct messages; where no claim would take them,
			// none could ever start, so the session gets no tools. Read when a session is made, after
			// every plugin set up: a conversation without a chat surface has them only when it is
			// recorded private to someone a direct channel knows. Creation checks the speaker's own
			// destination again.
			const offered = (
				session: SessionContext,
				extension: () => ExtensionFactory,
			): ExtensionFactory | null => {
				const home = session.homeChannel;
				if (surfaces.of(home))
					return conversations.takesBackground(home) ? extension() : null;
				if (directChannels.providers().length === 0) return null;
				// Only a conversation recorded private has a person to run its work for: a session
				// outlives the turn it is built in, so whoever speaks then decides nothing.
				const { conversation } = session;
				if (session.agent || conversation.visibility !== "private") return null;
				const own = conversation.principalId;
				return async (pi) => {
					// Only whether a direct channel knows them, without the network; the conversation there,
					// and whether a claim takes its turns, are checked when a tool runs.
					try {
						if (!(await directChannels.known(own))) return;
					} catch (error) {
						logger.warn(
							{ channel: home, err: error },
							"could not tell whether the conversation's person has a direct channel",
						);
						return;
					}
					await extension()(pi);
				};
			};
			// Whose a conversation is, as its session was made: an agent's serves everyone; another's
			// schedules are its person's in a private one, and the speaker's own in one no chat surface
			// carries, where its schedules are kept in a conversation it is not.
			const visibility =
				(session: SessionContext) =>
				async (): Promise<"private" | "shared"> => {
					if (session.agent) return "shared";
					if (session.conversation.visibility === "private") return "private";
					return surfaces.of(session.homeChannel) ? "shared" : "private";
				};
			const principalOf = identity ? legacyPrincipalsOf(identity) : undefined;
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
					fixed(
						"notify",
						sessionNotify({
							directChannels,
							owner,
							logger,
							onlyOwnerNotified: async () =>
								toolTiers.minTier("notify") === "owner" &&
								(identity ? (await identity.owners()).length <= 1 : true),
						}),
					),
					fixed("schedules", (session) =>
						offered(session, () =>
							schedulesExtension(
								{
									store: schedules,
									channelFor: scheduleChannelFor,
									...(prechecks ? { prechecks } : {}),
									holds: () => sessions().holds,
									visibility: visibility(session),
									...(principalOf ? { principalOf } : {}),
									target: personal,
								},
								session.homeChannel,
								session.agent ? agentChannelOf : undefined,
								session.speaker,
							),
						),
					),
					fixed("delegate", (session) =>
						offered(session, () =>
							delegateExtension(
								{ delegator, channelFor: delegateChannelFor },
								session.homeChannel,
								session.turnChannel,
								session.speaker,
							),
						),
					),
				],
				toolTiers: MODULE_TIERS,
				// Every person's conversations where a claim takes background turns are its own.
				backgroundTargets: [personal],
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
