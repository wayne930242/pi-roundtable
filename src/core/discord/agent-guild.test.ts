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

const failingTeam = {
	team: {
		status: () => [],
		onChange: () => {
			throw new Error("dashboard failed");
		},
	},
};
const ready = {
	plugin: AGENT_SERVER_PLUGIN,
	service: AGENT_TEAM_SERVICE,
	outcome: "ready",
} as const;

test("the replacement's handler runs after a dashboard handler that throws, and the dashboard's error is the one raised", async () => {
	const heard: string[] = [];
	const guild = discordAgentGuild(
		{
			...context,
			services: { find: () => failingTeam },
		} as never,
		{
			guild: "8",
			connection,
			own: { events: { serviceStarted: () => void heard.push("own") } },
		},
	);
	await expect(guild.events.serviceStarted?.(ready)).rejects.toThrow(
		"dashboard failed",
	);
	expect(heard).toEqual(["own"]);
});

test("when both handlers of an event throw, the first error is raised and the second is logged", async () => {
	const logged: unknown[] = [];
	const guild = discordAgentGuild(
		{
			...context,
			logger: {
				...silentLogger(),
				error: (...args: unknown[]) => logged.push(args),
			},
			services: { find: () => failingTeam },
		} as never,
		{
			guild: "8",
			connection,
			own: {
				events: {
					serviceStarted: () => {
						throw new Error("mine failed");
					},
				},
			},
		},
	);
	await expect(guild.events.serviceStarted?.(ready)).rejects.toThrow(
		"dashboard failed",
	);
	expect(logged).toHaveLength(1);
	expect(
		((logged[0] as [{ err: Error }])[0] as { err: Error }).err.message,
	).toBe("mine failed");
});
