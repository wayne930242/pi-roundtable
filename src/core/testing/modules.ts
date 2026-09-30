import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { modulesPlugin } from "../builtin/modules.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import { silentLogger } from "../log.ts";
import type { Contribution, PluginContext } from "../plugin.ts";
import {
	type CoreDiscord,
	CoreRegistry,
	type CoreStores,
} from "../services.ts";

/** What the modules' tools did, for a test to read. */
export interface ModuleRecord {
	/** Where each delegation job's thread opened. */
	threadOrigins: (ChannelKey | undefined)[];
	/** The channel each delegated report came back to. */
	reportChannels: ChannelKey[];
	/** How often a conversation without a chat channel fell back to the owner's messages. */
	ownerChannelAsked: number;
}

export const OWNER_CHANNEL: ChannelKey = "discord:owner-dm";

/** The modules plugin set up over stand-in stores and surface; returns its contribution and the record. */
export async function setUpModules(
	options: { agentChannelOf?: (name: string) => ChannelKey } = {},
): Promise<{
	contribution: Contribution;
	record: ModuleRecord;
	core: CoreRegistry;
}> {
	const record: ModuleRecord = {
		threadOrigins: [],
		reportChannels: [],
		ownerChannelAsked: 0,
	};
	const core = new CoreRegistry();
	// SAFETY: the tools under test read no store; each stub is asked for nothing else.
	core.provide("stores", {
		memory: {},
		schedules: {},
		confirmations: {},
		agents: {},
		skills: {},
	} as unknown as CoreStores);
	// SAFETY: the tools under test use the surface's owner channel and the threads' open only.
	core.provide("discord", {
		surface: {
			ownerChannel: async () => {
				record.ownerChannelAsked += 1;
				return OWNER_CHANNEL;
			},
			ownerDiscord: () => ({}),
		},
		threads: {
			open: async (origin: ChannelKey | undefined) => {
				record.threadOrigins.push(origin);
				return undefined;
			},
		},
		guard: {},
		cards: {},
		studio: {},
	} as unknown as CoreDiscord);
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
		...(options.agentChannelOf
			? { agentChannelOf: options.agentChannelOf }
			: {}),
	});
	// SAFETY: setup reads only the logger, the conversations' background, and the core services.
	const context = {
		logger: silentLogger(),
		conversations: {
			background: async (turn: { channel: ChannelKey }) => {
				record.reportChannels.push(turn.channel);
				return { status: "ran" };
			},
		},
		core,
	} as unknown as PluginContext;
	return { contribution: await plugin.setup(context), record, core };
}
