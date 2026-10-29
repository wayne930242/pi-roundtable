import { ConfigError } from "../domain/errors.ts";

/** The keys of the configuration that shape the agent team. */
interface AgentTeamKeys {
	agents?: readonly { name: string; channelId?: string }[];
	coordinator?: string;
	skills?: unknown;
}

/**
 * Refuses what the agent team needs and a host without Discord lacks, naming the key; and the
 * coordinator, which only a host without Discord names: with Discord it is the entry channel's agent.
 */
export function checkAgentTeamKeys(
	config: AgentTeamKeys,
	withDiscord: boolean,
): void {
	const seeds = config.agents ?? [];
	if (config.coordinator !== undefined) {
		if (withDiscord)
			throw new ConfigError(
				"config coordinator: the entry channel's agent is the coordinator with discord. Remove coordinator, or move the agent to discord.entryChannel.",
			);
		if (seeds.length === 0)
			throw new ConfigError(
				"config coordinator: needs agents, and names one of them. Add the agent to agents, or remove coordinator.",
			);
		if (!seeds.some((seed) => seed.name === config.coordinator))
			throw new ConfigError(
				`config coordinator: ${JSON.stringify(config.coordinator)} is not one of agents. Name one of ${seeds.map((seed) => seed.name).join(", ")}.`,
			);
	}
	if (withDiscord) return;
	const placed = seeds.findIndex((seed) => seed.channelId !== undefined);
	if (placed >= 0)
		throw new ConfigError(
			`config agents[${placed}].channelId: a Discord channel, and Discord is not configured. Remove channelId, or configure discord.`,
		);
	if (config.skills && seeds.length === 0)
		throw new ConfigError(
			"config skills: the skills are the agents', and this host has none: without discord they need agents. Configure agents or discord, or remove skills.",
		);
}

/** The keys of the configuration, as written, that only the agent server uses. */
interface AgentOnlyKeys {
	agents?: readonly unknown[];
	skills?: unknown;
	ops?: { agent?: string; conversation?: string };
	discord?: {
		agentMemory?: unknown;
		agentSpeakers?: unknown;
		attachmentDownload?: unknown;
	};
}

/**
 * Refuses, for `agentServer: false`, what only the agent server uses, as the configuration
 * writes it (not as defaults fill it): the seeds need the server to create them. An empty `agents`
 * list and `skills: false` say nothing, so they pass.
 */
export function checkAgentServerOff(config: AgentOnlyKeys): void {
	const used: [string, boolean][] = [
		["agents", (config.agents?.length ?? 0) > 0],
		["skills", config.skills !== undefined && config.skills !== false],
		["ops.agent", config.ops?.agent !== undefined],
		["discord.agentMemory", config.discord?.agentMemory !== undefined],
		["discord.agentSpeakers", config.discord?.agentSpeakers !== undefined],
		[
			"discord.attachmentDownload",
			config.discord?.attachmentDownload !== undefined,
		],
	];
	const found = used.find(([, set]) => set);
	if (found)
		throw new ConfigError(
			`config ${found[0]}: only the agent server uses it, and agentServer is false. Remove ${found[0]}, or remove agentServer to keep the agent server.`,
		);
}
