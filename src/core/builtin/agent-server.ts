import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SQL } from "bun";
import { agentClaim, OWNER_TARGET } from "../agents/agent-claim.ts";
import { AgentDashboard } from "../agents/agent-dashboard.ts";
import { PgAgentStore } from "../agents/agent-store.ts";
import { DiscordAgentTeam } from "../agents/agent-team.ts";
import { AGENT_TOOLS } from "../agents/agent-tools.ts";
import { FileAvatarStudio } from "../agents/avatar-studio.ts";
import { RelevanceScorer } from "../agents/group-round.ts";
import { discordKey } from "../agents/team-keys.ts";
import { ownerAttachmentDir } from "../attachments/attachment-dir.ts";
import type { AgentSessions } from "../contract/runtime.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import { ConfigError } from "../domain/errors.ts";
import type { OwnerIdentity } from "../identity.ts";
import { ConfirmationJudge } from "../judging/confirmation-judge.ts";
import { AUTO_THINKING, formatModelRef, type ModelRef } from "../models.ts";
import type { ErrorReporter } from "../ops/error-reporter.ts";
import type { PluginContext, RoundtablePlugin } from "../plugin.ts";
import { splitReply } from "../presentation/reply-splitter.ts";
import { agentPromptExtension } from "../runtime/extensions/agent-prompt.ts";
import type { AgentSessionsSlot } from "../runtime/runtime-plugin.ts";
import {
	AGENTS,
	BACKGROUND_TURNS,
	RUNTIME,
	SCHEDULES,
	SKILLS,
} from "../services.ts";
import type { SessionTool } from "../sessions.ts";
import type { SpeakerPolicy, Tier } from "../speakers.ts";
import { DISCORD } from "./discord.ts";
import { agentOnly } from "./session-tool.ts";

export interface AgentServerOptions {
	guildId: string;
	/** The channel the coordinator lives in. */
	entryChannelId: string;
	owner: OwnerIdentity & { id: string };
	/** The assistant's display name, as the confirmation judge names it. */
	assistant: string;
	/** Who may talk to the agents, and at which tier. */
	speakers: SpeakerPolicy;
	/** Shared with the rest of the host, so logins refresh in one place; lists the models an agent may run. */
	modelRuntime: ModelRuntime;
	dataDir: string;
	/** The model of agents and of the assistant. */
	model: ModelRef;
	/** How sure the confirmation judge must be before its answer is used. */
	judgeThreshold: number;
	/** Where the agent server hands the runtime plugin its per-agent settings. */
	agents?: AgentSessionsSlot;
	/** The shell's shared working directory. */
	workDir: string;
	/**
	 * The agents' scratch dir, created with mode 0700 when the agent server starts: their shell's
	 * TMPDIR, where writes and removals run without a hold.
	 */
	scratchDir?: string;
	/** The host account the agents' shell and file tools run as. */
	shellUser: string;
	/** The prompt every agent starts with, and the one for speakers other than the owner. */
	prompts: { shared: string; guest?: string };
	/** The listener the avatar pictures are served on. */
	avatarListener: string;
	/** The origin the agents' pictures are served from. */
	avatarUrl: string;
	/** The assistant's neutral avatar: the style reference and the picture of an agent without one. */
	avatarReference: string;
	/** Reports the process's own errors to an agent; without one nothing is reported. */
	errorReporter?: ErrorReporter;
}

/** The name of the agent server's plugin, as `serviceStarted` events name it. */
export const AGENT_SERVER_PLUGIN = "agent-server";

/**
 * The agent server's service that starts the team and the dashboard in the background: once its
 * `serviceStarted` event says `ready`, the agents' channels and the dashboard are up.
 */
export const AGENT_TEAM_SERVICE = "team";

/** The agent tools and the agent's own prompt, which only agent sessions load. */
export function agentSessionTools(
	team: Pick<DiscordAgentTeam, "extension" | "systemPrompt">,
): SessionTool[] {
	return [
		agentOnly("agent-tools", (scope) => team.extension(scope)),
		agentOnly("agent-prompt", (scope) =>
			agentPromptExtension(() => team.systemPrompt(scope)),
		),
	];
}

/** What every speaker may do with agents; admins create and edit them. */
const AGENT_TIERS: Readonly<Record<string, Tier>> = {
	...Object.fromEntries(AGENT_TOOLS.map((tool) => [tool, "admin" as const])),
	agent_list: "member",
	agent_get: "member",
	message_agent: "member",
	channel_read: "member",
};

/** The tables the agent server keeps: its agents and groups. */
export interface AgentServerStores {
	agents: PgAgentStore;
}

/** Attaches the agent server's stores over the host's migrated pool. */
async function attachStores(
	sql: SQL,
	guildId: string,
): Promise<AgentServerStores> {
	return { agents: await PgAgentStore.attach(sql, guildId) };
}

/**
 * The agent server: the team with its channels and dashboard, run on the runtime plugin's runtime,
 * which it hands its per-agent settings. The skills the agents carry come from the skills addon
 * when it is on. It claims the agent channels, starts the team in the background, and hands what
 * it built to the plugins after it.
 */
export function agentServerPlugin(
	options: AgentServerOptions,
	/** Opens the stores; a test hands stand-ins, so the plugin can be set up without a database. */
	openStores: (
		context: Pick<PluginContext, "database">,
		guildId: string,
	) => Promise<AgentServerStores> = (context, guildId) =>
		attachStores(context.database(), guildId),
): RoundtablePlugin {
	return {
		name: AGENT_SERVER_PLUGIN,
		// The agent server's own tables; the host runs them before any setup, in this order. The
		// held actions' table is the runtime plugin's.
		migrations: PgAgentStore.migrations(options.guildId),
		provides: [AGENTS],
		requires: [RUNTIME],
		setup: async (context) => {
			const discord = context.services.get(DISCORD);
			const schedules = context.services.get(SCHEDULES);
			const { connection } = discord;
			const { logger, providers, surfaces } = context;
			const studio = new FileAvatarStudio({
				dir: join(options.dataDir, "avatars"),
				publicUrl: options.avatarUrl,
				referencePath: options.avatarReference,
				// Without an image provider the studio makes each agent a picture from its name.
				...(providers.filled.has("images") ? { draw: providers.images } : {}),
			});
			await studio.init();
			// Absent when the skills addon is off: the agents then carry none.
			const skills = context.services.find(SKILLS);
			const { agents: store } = await openStores(context, options.guildId);
			const running = context.services.get(RUNTIME);
			const judge = providers.judge;
			const confirmations = new ConfirmationJudge({
				judge,
				threshold: options.judgeThreshold,
				assistant: options.assistant,
				logger,
			});
			const built: DiscordAgentTeam = new DiscordAgentTeam({
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
				...(options.scratchDir ? { scratchDir: options.scratchDir } : {}),
				store,
				channels: connection.agentChannels(options.guildId),
				studio,
				runtime: () => running,
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
				schedules,
				queue: context.queue,
				startTyping: (channel) => surfaces.startTyping(channel),
				showStop: (channel) => surfaces.showStop(channel),
				workDir: options.workDir,
				sharedPrompt: options.prompts.shared,
				...(options.prompts.guest
					? { guestPrompt: options.prompts.guest }
					: {}),
				...(skills ? { skills } : {}),
				threads: discord.threads,
				logger,
			});
			connection.onChannelDeleted((channelId) => {
				if (!built.owns(discordKey(channelId))) return;
				void context.queue
					.run(discordKey(channelId), () => built.channelDeleted(channelId))
					// pi-lens-ignore: no-unknown-parameters
					.catch((error: unknown) =>
						logger.error({ channelId, err: error }, "archive failed"),
					);
			});
			const agentSessions: AgentSessions = {
				workDir: options.workDir,
				...(options.scratchDir
					? { scratchDir: ensureScratchDir(options.scratchDir) }
					: {}),
				modelOf: (name) => built.modelOf(name),
				skills: (name) => built.skillsOf(name),
				turnChannel: (scope) => built.turnChannel(scope),
			};
			options.agents?.bind(agentSessions);
			context.services.provide(AGENTS, {
				team: built,
				directory: store,
				runtime: running,
				approvals: confirmations,
				avatars: studio,
			});
			const attachmentDir = (channel: ChannelKey) =>
				ownerAttachmentDir(options.dataDir, channel);
			const dashboard = new AgentDashboard({
				status: () => built.status(),
				board: connection.agentDashboard(options.guildId),
				lines: () => context.dashboard(),
				logger,
			});
			built.onChange(() => dashboard.changed());
			const connectErrorReporter = () =>
				options.errorReporter?.connect({
					channelOf: (name) => {
						const agent = store.agent(name);
						return agent?.status === "active" && agent.channelId
							? discordKey(agent.channelId)
							: undefined;
					},
					post: (channel, text) =>
						surfaces.sendReply(channel, { chunks: splitReply(text) }),
					turn: (channel, text) =>
						context.services
							.get(BACKGROUND_TURNS)
							.runErrorReport(channel, text),
					logger,
				});
			return {
				services: [
					{ name: "dashboard", stop: () => dashboard.stop() },
					{
						name: AGENT_TEAM_SERVICE,
						// The dashboard shows the team, so it starts once the team has; the error
						// reporter connects whether or not the team did, since it reports the failure.
						startInBackground: async () => {
							try {
								await built.start();
								dashboard.start();
							} finally {
								connectErrorReporter();
							}
						},
					},
				],
				// The schedules and delegated tasks of the owner's and the agents' conversations are its own.
				backgroundTargets: [OWNER_TARGET],
				channels: [
					agentClaim({
						owner: options.owner,
						speakers: options.speakers,
						team: built,
						runtime: running,
						surface: context.surfaces,
						attachmentDir,
						logger,
					}),
				],
				http: [studio.route(options.avatarListener)],
				sessionTools: agentSessionTools(built),
				toolTiers: AGENT_TIERS,
			};
		},
	};
}

/**
 * Creates the scratch dir for the service user alone. A shared temp dir lets anyone create the
 * path first, so a symlink or a dir the service user does not own is refused.
 */
export function ensureScratchDir(dir: string): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stat = lstatSync(dir);
	if (!stat.isDirectory() || stat.uid !== process.getuid?.())
		throw new ConfigError(
			`the scratch dir ${dir} is not a directory of this service's user. Remove it or set scratchDir to another path.`,
		);
	chmodSync(dir, 0o700);
	return dir;
}
