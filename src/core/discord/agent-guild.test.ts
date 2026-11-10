import { expect, test } from "bun:test";
import { silentLogger } from "../kernel/log.ts";
import {
	AGENT_SERVER_PLUGIN,
	AGENT_TEAM_SERVICE,
} from "../plugin-api/agent-server-ids.ts";
import type { PluginContext } from "../plugin-api/plugin.ts";
import { discordAgentGuild } from "./agent-guild.ts";

const context = {
	logger: silentLogger(),
	dashboard: () => [],
	services: { find: () => undefined },
} as unknown as Pick<PluginContext, "services" | "logger" | "dashboard">;
const connection = {
	agentChannels: () => ({}) as never,
	agentDashboard: () => ({ show: async () => undefined }),
	onChannelDeleted: () => undefined,
};

test("the services and event handlers a replacement makes itself are kept beside the dashboard's, not replaced by them", async () => {
	const heard: string[] = [];
	const guild = discordAgentGuild(context, {
		guild: "8",
		connection,
		own: {
			services: [{ name: "mine" }],
			events: {
				serviceStarted: () => void heard.push("own serviceStarted"),
				turnEnded: () => void heard.push("own turnEnded"),
			},
		},
	});
	expect(guild.services.map(({ name }) => name)).toEqual(["dashboard", "mine"]);
	expect(Object.keys(guild.events).sort()).toEqual([
		"serviceStarted",
		"turnEnded",
	]);
	// The dashboard's handler hears the event as well: with no agent team it makes nothing, and the replacement's runs.
	await guild.events.serviceStarted?.({
		plugin: AGENT_SERVER_PLUGIN,
		service: AGENT_TEAM_SERVICE,
		outcome: "ready",
	});
	await guild.events.turnEnded?.({} as never);
	expect(heard).toEqual(["own serviceStarted", "own turnEnded"]);
});

test("an error from a handler of the replacement's is raised, as the host would have seen it from the plugin's own", async () => {
	const guild = discordAgentGuild(context, {
		guild: "8",
		connection,
		own: {
			events: {
				serviceStarted: () => {
					throw new Error("mine failed");
				},
			},
		},
	});
	await expect(
		guild.events.serviceStarted?.({
			plugin: "other",
			service: "x",
			outcome: "ready",
		}),
	).rejects.toThrow("mine failed");
});
