/** The name of the agent server's plugin, as `serviceStarted` events name it. */
export const AGENT_SERVER_PLUGIN = "agent-server";

/**
 * The agent server's service that starts the team in the background: once its `serviceStarted`
 * event says `ready`, the agents' places are up, and what shows the team, such as Discord's
 * dashboard, starts.
 */
export const AGENT_TEAM_SERVICE = "team";
