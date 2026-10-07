import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SQL } from "bun";
import { OWNER_TARGET } from "../agents/agent-claim.ts";
import { DISCORD, type DiscordServices } from "../builtin/discord.ts";
import { discordAdminPlugin } from "../builtin/discord-admin.ts";
import { type ModulesOptions, modulesPlugin } from "../builtin/modules.ts";
import { skillsPlugin } from "../builtin/skills.ts";
import { memoryPlugin } from "../builtin/stores.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import { silentLogger } from "../log.ts";
import type { SkillStore } from "../modules/skills/skill-store.ts";
import {
	type Contribution,
	type PluginContext,
	pluginContext,
	type RoundtablePlugin,
} from "../plugin.ts";
import { ServiceRegistry } from "../registry/services.ts";
import { surfacePort } from "../routing/surface-port.ts";
import type { AgentServer, MemoryStore, ScheduleStore } from "../services.ts";
import { AGENTS, MEMORY, SCHEDULES } from "../services.ts";

/** What the modules' tools did, for a test to read. */
export interface ModuleRecord {
	/** Where each delegation job's thread opened. */
	threadOrigins: (ChannelKey | undefined)[];
	/** The channel each delegated report came back to. */
	reportChannels: ChannelKey[];
	/** How often a conversation without a chat channel fell back to the owner's messages. */
	ownerChannelAsked: number;
	/** What was posted on the surface, by channel. */
	posted: { channel: ChannelKey; text: string }[];
}

export const OWNER_CHANNEL: ChannelKey = "discord:owner-dm";

/** The modules plugin set up over stand-in stores and surface; returns its contribution and the record. */
export async function setUpModules(
	options: {
		agentChannelOf?: (name: string) => ChannelKey;
		/** Whether Discord is there; default true. A host without it has no owner's messages. */
		discord?: boolean;
		/** Whether a plugin contributes the owner's background target, as the agent server does; default true. */
		ownerTarget?: boolean;
		errorReporter?: ModulesOptions["errorReporter"];
	} = {},
): Promise<{
	contribution: Contribution;
	record: ModuleRecord;
	services: ServiceRegistry;
}> {
	const record: ModuleRecord = {
		threadOrigins: [],
		reportChannels: [],
		ownerChannelAsked: 0,
		posted: [],
	};
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
	});
	const services = new ServiceRegistry([plugin]);
	// SAFETY: the tools under test read no store; each stub is asked for nothing else.
	services.preset(MEMORY, {} as MemoryStore);
	services.preset(SCHEDULES, {} as ScheduleStore);
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
	// SAFETY: setup reads only the logger, the conversations' background and targets, the surfaces, and the services.
	const context = {
		logger: silentLogger(),
		conversations: {
			target: (name: string) =>
				options.ownerTarget !== false && name === OWNER_TARGET.name
					? OWNER_TARGET
					: undefined,
			background: async (turn: { channel: ChannelKey }) => {
				record.reportChannels.push(turn.channel);
				return { status: "ran" };
			},
		},
		// Only Discord's channels have a surface; any other conversation has none to report in.
		surfaces: surfacePort(() => [
			{
				surface: "discord",
				start: async () => undefined,
				sendReply: async (channel, reply) =>
					void record.posted.push({ channel, text: reply.chunks.join("") }),
			},
		]),
	} as unknown as Omit<PluginContext, "services">;
	const contribution = await services.setUp(plugin, () =>
		plugin.setup(pluginContext(plugin, context, services.forPlugin(plugin))),
	);
	return { contribution, record, services };
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
