import type { DashboardBoard } from "../contract/agent-channels.ts";
import type { Logger } from "../kernel/log.ts";
import {
	AGENT_SERVER_PLUGIN,
	AGENT_TEAM_SERVICE,
} from "../plugin-api/agent-server-ids.ts";
import type { Contribution } from "../plugin-api/plugin.ts";
import type { AgentTeam } from "../plugin-api/services.ts";
import { AgentDashboard } from "./agent-dashboard.ts";

export interface AgentDashboardContributionOptions {
	/** The `#dashboard` message of the agent guild. */
	board: DashboardBoard;
	/** The agent server's team, read once its service is ready; undefined on a host whose agent server is off. */
	agents: () => Pick<AgentTeam, "status" | "onChange"> | undefined;
	/** The plugins' lines under the title, read at each update. */
	lines: () => readonly string[];
	logger: Logger;
}

/**
 * The Discord plugin's dashboard: the `#dashboard` message shows the team, and starts once the
 * agent server's team service is ready, since it shows what that start made. A team that fails to
 * start has none. Refreshed when a turn starts or ends and when an agent or group changes.
 */
export function agentDashboardContribution(
	options: AgentDashboardContributionOptions,
): Pick<Contribution, "services" | "events"> {
	let dashboard: AgentDashboard | undefined;
	return {
		services: [{ name: "dashboard", stop: () => dashboard?.stop() }],
		events: {
			serviceStarted: (event) => {
				if (
					event.plugin !== AGENT_SERVER_PLUGIN ||
					event.service !== AGENT_TEAM_SERVICE ||
					event.outcome !== "ready" ||
					dashboard
				)
					return;
				const team = options.agents();
				if (!team) return;
				const started = new AgentDashboard({
					status: () => team.status(),
					board: options.board,
					lines: options.lines,
					logger: options.logger,
				});
				team.onChange(() => started.changed());
				dashboard = started;
				started.start();
			},
		},
	};
}
