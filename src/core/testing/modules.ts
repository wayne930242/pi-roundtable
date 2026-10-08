import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SQL } from "bun";
import { DISCORD, type DiscordServices } from "../builtin/discord.ts";
import { discordAdminPlugin } from "../builtin/discord-admin.ts";
import { type ModulesOptions, modulesPlugin } from "../builtin/modules.ts";
import { skillsPlugin } from "../builtin/skills.ts";
import { memoryPlugin } from "../builtin/stores.ts";
import type { ConversationRegistry } from "../conversations/conversation-registry.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import { silentLogger } from "../log.ts";
import { PERSONAL_TARGET } from "../modules/background/personal-target.ts";
import type { SkillStore } from "../modules/skills/skill-store.ts";
import {
	type Contribution,
	type PluginContext,
	pluginContext,
	type RoundtablePlugin,
} from "../plugin.ts";
import {
	type DirectChannelProvider,
	directChannelsPort,
} from "../presence/direct-channels.ts";
import { ServiceRegistry } from "../registry/services.ts";
import { surfacePort } from "../routing/surface-port.ts";
import type { AgentServer, MemoryStore, ScheduleStore } from "../services.ts";
import { AGENTS, CONVERSATIONS, MEMORY, SCHEDULES } from "../services.ts";

/** What the modules' tools did, for a test to read. */
export interface ModuleRecord {
	/** Where each delegation job's thread opened. */
	threadOrigins: (ChannelKey | undefined)[];
	/** The channel each delegated report came back to. */
	reportChannels: ChannelKey[];
	/** How often anything asked the connection for the primary owner's messages, which the modules no longer read. */
	ownerChannelAsked: number;
	/** Whose direct channel was asked for, in order. */
	directAsked: string[];
	/** The notices sent through a direct channel, by principal. */
	notified: { principalId: string; text: string }[];
	/** What was posted on the surface, by channel. */
	posted: { channel: ChannelKey; text: string }[];
}

export const OWNER_CHANNEL: ChannelKey = "discord:owner-dm";

/** The direct messages the stand-in Discord provider reaches by default: the owner's, principal "1". */
const DIRECT: Readonly<Record<string, ChannelKey>> = { "1": OWNER_CHANNEL };

/** The modules plugin set up over stand-in stores and surface; returns its contribution and the record. */
export async function setUpModules(
	options: {
		agentChannelOf?: (name: string) => ChannelKey;
		/** Whether Discord is there; default true. A host without it has no owner's messages. */
		discord?: boolean;
		/** Whether a plugin contributes the owner's background target, as the agent server does; default true. */
		ownerTarget?: boolean;
		/** Whether a claim owns a channel; by default the Discord channels are owned and no other. */
		owns?: (channel: ChannelKey) => boolean;
		/** Whether the claim owning a channel takes background turns; by default every owned channel's does. */
		takesBackground?: (channel: ChannelKey) => boolean;
		errorReporter?: ModulesOptions["errorReporter"];
		/** The schedules the tools keep; by default a stub that answers nothing. */
		schedules?: ScheduleStore;
		/** The conversations the host records, which say whose a conversation is; by default none is recorded. */
		conversations?: Pick<ConversationRegistry, "get">;
		/**
		 * Each principal's direct messages on the stand-in Discord provider, the host's only direct
		 * channel; by default the owner's are `OWNER_CHANNEL`, and without Discord there is none.
		 */
		direct?: Readonly<Record<string, ChannelKey>>;
		/** The modules' options besides the test's own. */
		modules?: Partial<ModulesOptions>;
	} = {},
): Promise<{
	plugin: RoundtablePlugin;
	contribution: Contribution;
	record: ModuleRecord;
	services: ServiceRegistry;
}> {
	const record: ModuleRecord = {
		threadOrigins: [],
		reportChannels: [],
		ownerChannelAsked: 0,
		directAsked: [],
		notified: [],
		posted: [],
	};
	const direct =
		options.direct ?? (options.discord === false ? undefined : DIRECT);
	const providers: DirectChannelProvider[] = direct
		? [
				{
					name: "discord",
					label: "a direct message on Discord",
					reaches: async (principalId) => {
						record.directAsked.push(principalId);
						return direct[principalId];
					},
					deliver: async (principalId, text) =>
						void record.notified.push({ principalId, text }),
				},
			]
		: [];
	const plugin = modulesPlugin({
		owner: {
			id: "1",
			name: "Owner",
			pronouns: { subject: "they", object: "them", possessive: "their" },
		},
		assistant: "Assistant",
		// SAFETY: a worker of the test's own replaces the one that would read the runtime.
		modelRuntime: {} as ModelRuntime,
		agentDir: "/tmp/agent",
		dataDir: "/tmp/data",
		delegation: {
			model: { provider: "test", id: "worker" },
			thinking: "low",
			worker: { run: async () => "found it" },
		},
		...(options.errorReporter ? { errorReporter: options.errorReporter } : {}),
		...options.modules,
	});
	const services = new ServiceRegistry([plugin]);
	// SAFETY: the tools under test read no store; each stub is asked for nothing else.
	services.preset(MEMORY, {} as MemoryStore);
	services.preset(SCHEDULES, options.schedules ?? ({} as ScheduleStore));
	if (options.conversations)
		// SAFETY: the schedule tools only read a conversation's record.
		services.preset(
			CONVERSATIONS,
			options.conversations as unknown as ConversationRegistry,
		);
	if (options.agentChannelOf)
		// SAFETY: the schedule tools ask the agent team for a channel and nothing else.
		services.preset(AGENTS, {
			team: { channelOf: options.agentChannelOf },
		} as unknown as AgentServer);
	if (options.discord !== false)
		// SAFETY: the tools under test use the connection's owner channel and the threads' open only.
		services.preset(DISCORD, {
			connection: {
				ownerChannel: async () => {
					record.ownerChannelAsked += 1;
					return OWNER_CHANNEL;
				},
				ownerOperations: () => ({}),
			},
			threads: {
				open: async (origin: ChannelKey | undefined) => {
					record.threadOrigins.push(origin);
					return undefined;
				},
			},
			guard: {},
			commands: { add: () => undefined },
		} as unknown as DiscordServices);
	const owns =
		options.owns ?? ((channel: ChannelKey) => channel.startsWith("discord:"));
	// Only Discord's channels have a surface; any other conversation has none to report in.
	const surfaces = surfacePort(() => [
		{
			surface: "discord",
			start: async () => undefined,
			sendReply: async (channel, reply) =>
				void record.posted.push({ channel, text: reply.chunks.join("") }),
		},
	]);
	// SAFETY: setup and the preflight read only the logger, the conversations' background, targets and owners, the surfaces, the direct channels, and the services.
	const context = {
		logger: silentLogger(),
		conversations: {
			target: (name: string) =>
				options.ownerTarget !== false && name === PERSONAL_TARGET.name
					? PERSONAL_TARGET
					: undefined,
			owns,
			takesBackground: options.takesBackground ?? owns,
			background: async (turn: { channel: ChannelKey }) => {
				record.reportChannels.push(turn.channel);
				return { status: "ran" };
			},
		},
		surfaces,
		directChannels: directChannelsPort(() => providers, surfaces),
	} as unknown as Omit<PluginContext, "services">;
	const contribution = await services.setUp(plugin, () =>
		plugin.setup(pluginContext(plugin, context, services.forPlugin(plugin))),
	);
	return { plugin, contribution, record, services };
}

/** What each addon plugin contributes, set up over stand-ins as far as setup reads them. */
export async function setUpAddons(): Promise<{
	memory: Contribution;
	discordAdmin: Contribution;
	skills: Contribution;
}> {
	const owner = {
		id: "1",
		name: "Owner",
		pronouns: { subject: "they", object: "them", possessive: "their" },
	} as const;
	const memory = memoryPlugin({ owner });
	const admin = discordAdminPlugin({ owner });
	// SAFETY: the tools under test read the store only when a skill tool runs.
	const store = { skills: () => [] } as unknown as SkillStore;
	const skills = skillsPlugin(
		{
			guildId: "g1",
			reposDir: "/tmp/repos",
			writtenDir: "/tmp/written",
			builtinDir: "/tmp/builtin",
		},
		async () => store,
	);
	const services = new ServiceRegistry([memory, admin, skills]);
	// SAFETY: the admin tools ask the surface for the owner's Discord only when one runs.
	services.preset(DISCORD, {
		connection: { ownerOperations: () => ({}) },
	} as unknown as DiscordServices);
	// SAFETY: setup reads only the logger, the database handle, and the services.
	const context = {
		logger: silentLogger(),
		database: () => ({}) as SQL,
	} as unknown as Omit<PluginContext, "services">;
	const setUp = (plugin: RoundtablePlugin) =>
		services.setUp(plugin, () =>
			plugin.setup(pluginContext(plugin, context, services.forPlugin(plugin))),
		);
	return {
		memory: await setUp(memory),
		discordAdmin: await setUp(admin),
		skills: await setUp(skills),
	};
}
