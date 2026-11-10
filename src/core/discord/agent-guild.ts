import type { Client } from "discord.js";
import type {
	Contribution,
	EventHandlers,
	PluginContext,
} from "../plugin-api/plugin.ts";
import { AGENTS } from "../plugin-api/services.ts";
import { agentDashboardContribution } from "./agent-dashboard-service.ts";
import { discordPlaces } from "./agent-places.ts";
import { discordAgentTools, discordTeamReads } from "./agent-tools.ts";
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
	/**
	 * The services and event handlers the plugin contributes itself. Spreading the result puts
	 * `services` and `events` in place of the plugin's own, so give them here: the services follow
	 * the dashboard's, and a handler of an event the dashboard also hears runs after it, and runs
	 * even when the dashboard's throws.
	 */
	own?: Pick<Contribution, "services" | "events">;
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
 *   ready. A plugin with services or event handlers of its own gives them as `own`, and the result
 *   merges them with these.
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
	const directory = () => {
		const server = services.find(AGENTS);
		return server && discordTeamReads(server);
	};
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
				nameOf: (channelId) => directory()?.ownerOf(channelId),
				logger,
			}),
		],
		tools: discordAgentTools({ channels, directory, logger }),
		services: [...(dashboard.services ?? []), ...(options.own?.services ?? [])],
		events: mergedEvents(
			dashboard.events ?? {},
			options.own?.events ?? {},
			logger,
		),
	};
}

/**
 * Handlers of both sets under one event name each: those of an event both hear run in order, each
 * even when one before it throws. The first error is the one raised, as the bus logs it; the later
 * ones are logged here, or they would be lost.
 */
function mergedEvents(
	first: EventHandlers,
	second: EventHandlers,
	logger: Pick<PluginContext["logger"], "error">,
): EventHandlers {
	const merged: Record<string, (...args: unknown[]) => Promise<void>> = {};
	const names = new Set([...Object.keys(first), ...Object.keys(second)]);
	for (const name of names) {
		const handlers = [first, second].flatMap((set) => {
			const handler = (set as Record<string, unknown>)[name] as
				| ((...args: unknown[]) => Promise<void> | void)
				| undefined;
			return handler ? [{ set, handler }] : [];
		});
		merged[name] = async (...args) => {
			const failures: unknown[] = [];
			for (const { set, handler } of handlers)
				try {
					await handler.apply(set, args);
				} catch (error) {
					failures.push(error);
				}
			for (const error of failures.slice(1))
				logger.error(
					{ err: error, event: name },
					"a later handler of the event failed",
				);
			if (failures.length > 0) throw failures[0];
		};
	}
	return merged as EventHandlers;
}
