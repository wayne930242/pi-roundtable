import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SQL } from "bun";
import { agentClaim } from "../agents/agent-claim.ts";
import { AgentDashboard } from "../agents/agent-dashboard.ts";
import { PgAgentStore } from "../agents/agent-store.ts";
import { DiscordAgentTeam } from "../agents/agent-team.ts";
import { AGENT_TOOLS } from "../agents/agent-tools.ts";
import { FileAvatarStudio } from "../agents/avatar-studio.ts";
import { RelevanceScorer } from "../agents/group-round.ts";
import { modeOrigins } from "../agents/helper-modes.ts";
import { Routes } from "../agents/routes.ts";
import { agentOfChannel, discordKey } from "../agents/team-keys.ts";
import { ownerAttachmentDir } from "../attachments/attachment-dir.ts";
import { ROOM_LAYOUT } from "../contract/room-layout.ts";
import type { AgentSessions } from "../contract/runtime.ts";
import { LEGACY_CHANNEL_SURFACE } from "../db/legacy-channels.ts";
import { moveTeam } from "../db/team-move.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import { ConfigError } from "../domain/errors.ts";
import { AUTO_THINKING, formatModelRef } from "../domain/models.ts";
import type { SessionTool } from "../domain/sessions.ts";
import type { Tier } from "../identity/speakers.ts";
import { ConfirmationJudge } from "../judging/confirmation-judge.ts";
import type { Logger } from "../kernel/log.ts";
import type { PluginContext, RoundtablePlugin } from "../plugin-api/plugin.ts";
import {
	AGENTS,
	BACKGROUND_TURNS,
	IDENTITY,
	MODES,
	PROMPTS,
	RUNTIME,
	SCHEDULES,
	SKILLS,
} from "../plugin-api/services.ts";
import { splitReply } from "../presentation/reply-splitter.ts";
import { agentPromptExtension } from "../runtime/extensions/agent-prompt.ts";
import { DISCORD } from "./discord.ts";
import { agentOnly } from "./session-tool.ts";

export {
	type AgentServerOptions,
	LOCAL_TEAM_ID,
} from "./agent-server-options.ts";

import {
	type AgentServerOptions,
	LOCAL_TEAM_ID,
} from "./agent-server-options.ts";

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
	logger: Logger,
): SessionTool[] {
	return [
		agentOnly("agent-tools", (scope) => team.extension(scope)),
		agentOnly("agent-prompt", (scope) =>
			agentPromptExtension(() => team.systemPrompt(scope), logger, scope.name),
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
	// A knight may make temp knights for whoever is talking to it; the limits hold the cost.
	helper_create: "member",
	helper_end: "member",
	helper_preset_set: "member",
	helper_preset_list: "member",
	helper_preset_delete: "member",
};

/** The tables the agent server keeps: its agents and groups. */
export interface AgentServerStores {
	agents: PgAgentStore;
}

/** Attaches the agent server's stores over the host's migrated pool. */
async function attachStores(
	sql: SQL,
	teamId: string,
): Promise<AgentServerStores> {
	return { agents: await PgAgentStore.attach(sql, teamId) };
}

/**
 * The agent server: the team with its channels and dashboard, run on the runtime plugin's runtime,
 * which it hands its per-agent settings. The skills the agents carry come from the skills addon
 * when it is on. It claims the agent channels, starts the team in the background, and hands what
 * it built to the plugins after it. On a host without Discord the team has no channels or
 * dashboard: its agents live in the rooms of the surfaces that host them, and the host refuses to
 * start when no surface does.
 */
export function agentServerPlugin(
	options: AgentServerOptions,
	/** Opens the stores; a test hands stand-ins, so the plugin can be set up without a database. */
	openStores: (
		context: Pick<PluginContext, "database">,
		teamId: string,
	) => Promise<AgentServerStores> = (context, teamId) =>
		attachStores(context.database(), teamId),
): RoundtablePlugin {
	if (options.entryChannelId !== undefined && options.coordinator !== undefined)
		throw new ConfigError(
			"the agent server: entryChannelId and coordinator both name the coordinator. Set the entry channel with Discord, the coordinator without it.",
		);
	const teamId = options.teamId ?? options.guildId ?? LOCAL_TEAM_ID;
	/** Set once the plugin has set up; the preflight reads it after every plugin linked. */
	let hostsRooms: (() => boolean) | undefined;
	let linkRoutes: (() => void) | undefined;
	return {
		name: AGENT_SERVER_PLUGIN,
		// The agent server's own tables; the host runs them before any setup, in this order. The
		// held actions' table is the runtime plugin's.
		migrations: [
			...PgAgentStore.migrations(teamId),
			// After the agents' tables, and the prompts', skills' and conversations' before it.
			moveTeam({
				from: options.formerTeamIds ?? [],
				to: teamId,
				...(options.guildId === undefined
					? { clearChannels: true }
					: { discordGuild: options.guildId }),
				// The legacy channels' places follow their columns: kept in the agent guild, dropped elsewhere.
				places: [
					{
						surface: LEGACY_CHANNEL_SURFACE,
						...(options.guildId === undefined ? {} : { keep: options.guildId }),
					},
				],
			}),
			// After the move, so the rows it brought in with their channel ids get their places at this boot.
			PgAgentStore.placesConvergence(teamId),
		],
		provides: [AGENTS],
		requires: [RUNTIME],
		// A team with no Discord channels is reached through rooms only; without a surface that
		// hosts them its agents could never be spoken to.
		preflight: () => {
			if (hostsRooms && !hostsRooms())
				throw new ConfigError(
					"the agents need a surface that hosts their rooms, such as pi-roundtable-web, and none is installed. Without Discord channels there is nowhere to talk to them; add a plugin whose chat surface declares agentRooms: true, or configure discord with its guild.",
				);
			// The surfaces the rules name exist only once every plugin has registered its own.
			linkRoutes?.();
		},
		setup: async (context) => {
			// Absent on a host without Discord: then the team has no channels or dashboard.
			const discord = context.services.find(DISCORD);
			const schedules = context.services.get(SCHEDULES);
			const connection = discord?.connection;
			const { logger, providers, surfaces } = context;
			// The team's Discord channels, in the agent guild; a bot without one serves only the plugins.
			const channels =
				connection && options.guildId
					? connection.agentChannels(options.guildId)
					: undefined;
			if (!channels) hostsRooms = () => surfaces.roomSurfaces().length > 0;
			const studio = new FileAvatarStudio({
				dir: join(options.dataDir, "avatars"),
				skins: context.env.characterSkins,
				...(options.avatarUrl ? { publicUrl: options.avatarUrl } : {}),
				referencePath: options.avatarReference,
				...(options.avatarNeutral
					? {
							neutralPath: options.avatarNeutral,
							onReferenceFailed: (code: string) =>
								logger.warn(
									{ code },
									"the configured avatar could not be used; the neutral avatar is used instead",
								),
						}
					: {}),
				// Without an image provider the studio makes each agent a picture from its name.
				...(providers.filled.has("images") ? { draw: providers.images } : {}),
			});
			await studio.init();
			// Absent when the skills addon is off: the agents then carry none.
			const skills = context.services.find(SKILLS);
			const { agents: store } = await openStores(context, teamId);
			// A temp knight's conversations follow the modes of the one that made it.
			context.services.find(MODES)?.trackOrigins(modeOrigins(store, surfaces));
			const running = context.services.get(RUNTIME);
			const judge = providers.judge;
			const confirmations = new ConfirmationJudge({
				judge,
				threshold: options.judgeThreshold,
				assistant: options.assistant,
				logger,
			});
			// The owner edits the two prompts in the app when the prompts plugin is there; the text from the files is their default.
			const documents = context.services.find(PROMPTS);
			const shared = documents?.register({
				id: "shared",
				label: "Shared prompt",
				description:
					"The base every agent's prompt starts with, the main assistant's included.",
				default: options.prompts.shared,
			});
			const guest =
				documents && options.prompts.guest
					? documents.register({
							id: "guest",
							label: "Guest prompt",
							description:
								"Used instead of the shared prompt when the person speaking is not the owner.",
							default: options.prompts.guest,
						})
					: undefined;
			const sharedPrompt = shared ? () => shared.text() : undefined;
			const guestPrompt = guest ? () => guest.text() : undefined;
			const routes = new Routes({
				routing: options.routing,
				store,
				roomSurfaces: () => surfaces.roomSurfaces(),
				latest: (agent) => store.conversations.latest(agent),
				discordChannels: channels !== undefined,
				logger,
			});
			// The surfaces the rules name are registered by the time every plugin has set up.
			linkRoutes = () =>
				routes.validate({
					names: surfaces.names?.() ?? [],
					discordChannels: channels !== undefined,
				});
			const built: DiscordAgentTeam = new DiscordAgentTeam({
				routes,
				guildId: teamId,
				discordGuild: options.guildId,
				...(options.entryChannelId !== undefined
					? { entryChannelId: options.entryChannelId }
					: {}),
				// Without an entry channel the coordinator is the named agent, else the first seed.
				...(options.entryChannelId === undefined
					? {
							coordinator: () =>
								options.coordinator ?? context.sessions().seeds[0]?.name,
						}
					: {}),
				seeds: () => context.sessions().seeds,
				promptSections: () => context.sessions().prompt,
				agentTools: context.env.agentTools,
				pluginTools: () => context.sessions().agentTools,
				pluginSelection: () => context.sessions().agentSelection(),
				events: context.events,
				owner: options.owner,
				toolTiers: context.toolTiers,
				shellUser: options.shellUser,
				...(options.scratchDir ? { scratchDir: options.scratchDir } : {}),
				store,
				...(channels ? { channels } : {}),
				studio,
				...(options.refreshAvatars ? { refreshAvatars: true } : {}),
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
				surfaces,
				startTyping: (channel) => surfaces.startTyping(channel),
				showStop: (channel) => surfaces.showStop(channel),
				workDir: options.workDir,
				sharedPrompt: sharedPrompt ?? options.prompts.shared,
				...((guestPrompt ?? options.prompts.guest)
					? { guestPrompt: guestPrompt ?? options.prompts.guest }
					: {}),
				...(skills ? { skills } : {}),
				modes: () => context.services.find(MODES),
				rooms: () => context.services.find(ROOM_LAYOUT),
				...(options.helpers !== undefined ? { helpers: options.helpers } : {}),
				principals: () => context.services.find(IDENTITY),
				logger,
			});
			connection?.onChannelDeleted((channelId) => {
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
				...(options.memory ? { memory: options.memory } : {}),
			};
			options.agents?.bind(agentSessions);
			context.services.provide(AGENTS, {
				team: built,
				directory: store,
				runtime: running,
				approvals: confirmations,
				avatars: studio,
				routes,
				workspace: {
					workDir: options.workDir,
					...(agentSessions.scratchDir
						? { scratchDir: agentSessions.scratchDir }
						: {}),
				},
			});
			const attachmentDir = (channel: ChannelKey) =>
				ownerAttachmentDir(options.dataDir, channel);
			// The dashboard is a Discord message; a team without Discord has none.
			const dashboard =
				connection && options.guildId
					? new AgentDashboard({
							status: () => built.status(),
							board: connection.agentDashboard(options.guildId),
							lines: () => context.dashboard(),
							logger,
						})
					: undefined;
			if (dashboard) built.onChange(() => dashboard.changed());
			const connectErrorReporter = () =>
				options.errorReporter?.connect({
					channelOf: (name) =>
						store.agent(name)?.status === "active"
							? routes.primary(name)
							: undefined,
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
					...(dashboard
						? [{ name: "dashboard", stop: () => dashboard.stop() }]
						: []),
					{
						name: AGENT_TEAM_SERVICE,
						stop: () => built.stop(),
						busy: () => built.busy(),
						// The dashboard shows the team, so it starts once the team has; the error
						// reporter connects whether or not the team did, since it reports the failure.
						startInBackground: async () => {
							try {
								await built.start();
								dashboard?.start();
							} finally {
								connectErrorReporter();
							}
						},
					},
				],
				channels: [
					agentClaim({
						owner: options.owner,
						discordGuild: options.guildId,
						...(options.speakers ? { speakers: options.speakers } : {}),
						team: built,
						runtime: running,
						surface: context.surfaces,
						integrationChannel: (origin) => {
							const agent = agentOfChannel(store, surfaces, origin);
							return agent
								? routes.of(agent.name, "integration", origin)
								: origin;
						},
						attachmentDir,
						...(options.attachmentDownload
							? { attachmentDownload: options.attachmentDownload }
							: {}),
						logger,
						...(discord
							? { channelContext: (message) => discord.channelContext(message) }
							: {}),
					}),
				],
				// The pictures are public on a listener only where a public address reaches it.
				http:
					options.avatarListener && options.avatarUrl
						? [studio.route(options.avatarListener)]
						: [],
				sessionTools: agentSessionTools(built, logger),
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
