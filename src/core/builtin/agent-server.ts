import type {
	ExtensionFactory,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { agentClaim } from "../agents/agent-claim.ts";
import { AgentDashboard } from "../agents/agent-dashboard.ts";
import { AgentTeam } from "../agents/agent-team.ts";
import { RelevanceScorer } from "../agents/group-round.ts";
import { channelKey } from "../agents/team-keys.ts";
import { ownerAttachmentDir } from "../attachments/attachment-dir.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import type { OwnerIdentity } from "../identity.ts";
import { ConfirmationJudge } from "../judging/confirmation-judge.ts";
import { AGENT_BRIEF, EffortJudge } from "../judging/effort-judge.ts";
import {
	AUTO_THINKING,
	formatModelRef,
	type ModelRef,
	type ThinkingLevel,
} from "../models.ts";
import { SkillRegistry } from "../modules/skills/skill-registry.ts";
import type { ErrorReporter } from "../ops/error-reporter.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import { splitReply } from "../presentation/reply-splitter.ts";
import { agentPromptExtension } from "../runtime/extensions/agent-prompt.ts";
import { PiAgentRuntime } from "../runtime/pi-agent-runtime.ts";
import type { AgentTurnScope, SessionTool } from "../sessions.ts";
import type { SpeakerPolicy } from "../speakers.ts";

export interface AgentServerOptions {
	guildId: string;
	/** The channel the coordinator lives in. */
	entryChannelId: string;
	owner: OwnerIdentity & { id: string };
	/** The assistant's display name, as the confirmation judge names it. */
	assistant: string;
	/** Who may talk to the agents, and at which tier. */
	speakers: SpeakerPolicy;
	/** Shared with the rest of the host, so logins refresh in one place. */
	modelRuntime: ModelRuntime;
	agentDir: string;
	dataDir: string;
	/** The model of agents and of the assistant, and the thinking level a judge falls back to. */
	model: ModelRef;
	thinking: ThinkingLevel;
	/** How sure the judges must be before their answer is used. */
	judgeThreshold: number;
	/** The shell's shared working directory. */
	workDir: string;
	/** The host account the agents' shell and file tools run as. */
	shellUser: string;
	/** The prompt every agent starts with, and the one for speakers other than the owner. */
	prompts: { shared: string; guest?: string };
	/** Where the skill registry reads and writes skills. */
	skills: { reposDir: string; writtenDir: string; builtinDir: string };
	/** The listener the avatar pictures are served on. */
	avatarListener: string;
	/** Reports the process's own errors to an agent; without one nothing is reported. */
	errorReporter?: ErrorReporter;
	/**
	 * Conversations outside the agent server, such as the owner's own: their system prompt, and the
	 * tools startup refuses to run without.
	 */
	ownerSessions?: { persona: string; requiredTools: readonly string[] };
}

/** A session tool whose extension never changes, for agent sessions only. */
function agentOnly(
	name: string,
	factory: (scope: AgentTurnScope) => ExtensionFactory,
): SessionTool {
	return {
		name,
		phase: "tools",
		snapshot: () => ({
			revision: 0,
			factory: (session) => (session.agent ? factory(session.agent) : null),
		}),
	};
}

/** The agent tools and the agent's own prompt, which only agent sessions load. */
export function agentSessionTools(
	team: Pick<AgentTeam, "extension" | "systemPrompt">,
): SessionTool[] {
	return [
		agentOnly("agent-tools", (scope) => team.extension(scope)),
		agentOnly("agent-prompt", (scope) =>
			agentPromptExtension(() => team.systemPrompt(scope)),
		),
	];
}

/**
 * The agent server: the skill registry, the team with its channels and dashboard, and the
 * runtime that runs every agent turn. It claims the agent channels, starts the team in the
 * background, and hands what it built to the plugins after it.
 */
export function agentServerPlugin(
	options: AgentServerOptions,
): RoundtablePlugin {
	let runtime: PiAgentRuntime | undefined;
	let team: AgentTeam | undefined;
	let skills: SkillRegistry | undefined;
	return {
		name: "agent-server",
		// The skills are read once every plugin is set up, so a plugin may still place some in setup.
		preflight: async () => {
			skills?.init();
			await runtime?.preflight();
		},
		stopTurn: (channel) => runtime?.stop(channel) ?? false,
		agentServer: () => team?.start() ?? Promise.resolve(),
		setup: (context) => {
			const { stores, discord } = context.core;
			const { surface } = discord;
			const { logger, providers } = context;
			const judge = providers.judge;
			const confirmations = new ConfirmationJudge({
				judge,
				threshold: options.judgeThreshold,
				assistant: options.assistant,
				logger,
			});
			const registry = new SkillRegistry({
				store: stores.skills,
				reposDir: options.skills.reposDir,
				writtenDir: options.skills.writtenDir,
				builtinDir: options.skills.builtinDir,
				logger,
			});
			skills = registry;
			const built: AgentTeam = new AgentTeam({
				guildId: options.guildId,
				entryChannelId: options.entryChannelId,
				seeds: () => context.sessions().seeds,
				promptSections: () => context.sessions().prompt,
				pluginTools: () => context.sessions().agentTools,
				pluginSelection: () => context.sessions().agentSelection(),
				events: context.events,
				owner: options.owner,
				toolTiers: context.toolTiers,
				shellUser: options.shellUser,
				store: stores.agents,
				channels: surface.agentChannels(options.guildId),
				studio: discord.studio,
				// The runtime is built next, with this team's tools.
				runtime: () => {
					if (!runtime) throw new Error("the runtime is built with the team");
					return runtime;
				},
				confirmations,
				scorer: new RelevanceScorer(judge, logger, options.owner),
				models: {
					defaults: {
						model: formatModelRef(options.model),
						thinking: AUTO_THINKING,
					},
					// The snapshot is filled in the background at startup; a form must open within 3 s.
					usable: async () => {
						const snapshot = options.modelRuntime.getAvailableSnapshot();
						const models =
							snapshot.length > 0
								? snapshot
								: await options.modelRuntime.getAvailable();
						return models.map((model) => `${model.provider}/${model.id}`);
					},
				},
				schedules: stores.schedules,
				queue: context.queue,
				startTyping: (channel) => surface.startTyping(channel),
				showStop: (channel) => surface.showStop(channel),
				workDir: options.workDir,
				sharedPrompt: options.prompts.shared,
				...(options.prompts.guest
					? { guestPrompt: options.prompts.guest }
					: {}),
				skills: registry,
				threads: discord.threads,
				logger,
			});
			team = built;
			surface.onChannelDeleted((channelId) => {
				if (!built.owns(channelKey(channelId))) return;
				void context.queue
					.run(channelKey(channelId), () => built.channelDeleted(channelId))
					// pi-lens-ignore: no-unknown-parameters
					.catch((error: unknown) =>
						logger.error({ channelId, err: error }, "archive failed"),
					);
			});
			const running = new PiAgentRuntime({
				owner: options.owner,
				sessions: context.sessions,
				agentDir: options.agentDir,
				modelRuntime: options.modelRuntime,
				dataDir: options.dataDir,
				model: options.model,
				thinking: options.thinking,
				effort: new EffortJudge({
					judge,
					brief: AGENT_BRIEF,
					fallback: options.thinking,
					threshold: options.judgeThreshold,
					logger,
				}),
				persona: options.ownerSessions?.persona ?? "",
				confirmations: stores.confirmations,
				requiredTools: options.ownerSessions?.requiredTools ?? [],
				toolTiers: context.toolTiers,
				agents: {
					workDir: options.workDir,
					modelOf: (name) => built.modelOf(name),
					skills: (name) => built.skillsOf(name),
					turnChannel: (scope) => built.turnChannel(scope),
				},
				prompts: (channel, speaker) => discord.cards.prompts(channel, speaker),
				logger,
			});
			runtime = running;
			context.core.provide("agents", {
				team: built,
				runtime: running,
				skills: registry,
				confirmations,
			});
			const attachmentDir = (channel: ChannelKey) =>
				ownerAttachmentDir(options.dataDir, channel);
			const dashboard = new AgentDashboard({
				status: () => built.status(),
				board: surface.agentDashboard(options.guildId),
				lines: () => context.dashboard(),
				logger,
			});
			built.onChange(() => dashboard.changed());
			return {
				services: [
					{ name: "runtime", stop: () => running.dispose() },
					{ name: "dashboard", stop: () => dashboard.stop() },
				],
				channels: [
					agentClaim({
						owner: options.owner,
						speakers: options.speakers,
						team: built,
						runtime: running,
						surface,
						attachmentDir,
						logger,
					}),
				],
				http: [discord.studio.route(options.avatarListener)],
				sessionTools: agentSessionTools(built),
				events: {
					agentServer: (outcome) => {
						options.errorReporter?.connect({
							channelOf: (name) => {
								const agent = stores.agents.agent(name);
								return agent?.status === "active" && agent.channelId
									? channelKey(agent.channelId)
									: undefined;
							},
							post: (channel, text) =>
								surface.sendReply(channel, { chunks: splitReply(text) }),
							turn: (channel, text) =>
								context.core.background.runErrorReport(channel, text),
							logger,
						});
						if (outcome === "ready") dashboard.start();
					},
				},
			};
		},
	};
}
