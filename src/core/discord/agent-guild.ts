import type { Client } from "discord.js";
import type { Contribution, PluginContext } from "../plugin-api/plugin.ts";
import { AGENTS } from "../plugin-api/services.ts";
import { agentDashboardContribution } from "./agent-dashboard-service.ts";
import { discordPlaces } from "./agent-places.ts";
import { discordAgentTools, ownerNameOf } from "./agent-tools.ts";
import type { DiscordConnection } from "./connection.ts";

export interface DiscordAgentGuildOptions {
	/** The agent guild (`discord.guild`): the only server whose channels are the team's places. */
	guild: string;
	/**
	 * The Discord the host uses, as `DISCORD` provides it: the guild's channels, its `#dashboard`
	 * message and its deleted channels are read from it.
	 */
	connection: Pick<
		DiscordConnection,
		"agentChannels" | "agentDashboard" | "onChannelDeleted"
	>;
	/** The discord.js client, so the team can check at start that its stored channels still exist; absent = they are taken as they are. */
	client?: Client;
	/**
	 * The channel the coordinator lives in (`discord.entryChannel`): the agent in it is the
	 * coordinator. Absent = the first agent the host seeds, since a host with `discord.guild`
	 * names no coordinator in its configuration.
	 */
	entryChannel?: string;
}

/** Discord's side of the agent guild, as a plugin's setup returns it. */
export type DiscordAgentGuild = Required<
	Pick<Contribution, "places" | "tools" | "services" | "events">
>;

/**
 * Discord's side of the agent guild, for the plugin that provides `DISCORD`: the built-in Discord
 * plugin contributes it, and a plugin that replaces `DISCORD` with a Discord of its own spreads it
 * into what its setup returns whenever the host has `discord.guild`, since the built-in plugin is
 * left out whole then.
 *
 * - `places`: the guild's channels as the team's places, with the keys, seats and log names they
 *   have always had, so no stored session, schedule or held action moves; the provider names the
 *   coordinator's place from `entryChannel`, and writes the categories section of `agent_list`
 *   with the agents' and groups' names.
 * - `tools`: `channel_arrange` and `channel_read`, which an agent's turn carries.
 * - `services` and `events`: the `#dashboard` message, started once the agent server's team is
 *   ready. A plugin with services or event handlers of its own merges them with these.
 *
 * It reads the team through `AGENTS` when a tool runs or the dashboard updates, never during
 * setup, so the plugin may be set up before the agent server.
 */
export function discordAgentGuild(
	context: Pick<PluginContext, "services" | "logger" | "dashboard">,
	options: DiscordAgentGuildOptions,
): DiscordAgentGuild {
	const { guild, connection } = options;
	const { services, logger } = context;
	const channels = connection.agentChannels(guild);
	const directory = () => services.find(AGENTS)?.directory;
	const dashboard = agentDashboardContribution({
		board: connection.agentDashboard(guild),
		agents: () => services.find(AGENTS)?.team,
		lines: () => context.dashboard(),
		logger,
	});
	return {
		places: [
			discordPlaces({
				...(options.client ? { client: options.client } : {}),
				...(options.entryChannel === undefined
					? {}
					: { entryChannel: options.entryChannel }),
				guild,
				channels,
				onRemoved: (listener) => connection.onChannelDeleted(listener),
				nameOf: (channelId) => {
					const found = directory();
					return found ? ownerNameOf(found)(channelId) : undefined;
				},
				logger,
			}),
		],
		tools: discordAgentTools({ channels, directory, logger }),
		services: dashboard.services ?? [],
		events: dashboard.events ?? {},
	};
}
