import type { AgentTurnScope } from "../domain/ports.ts";
import { SHELL_TOOLS } from "../modules/host-shell/shell-policy.ts";
import type { TurnSelection } from "../sessions.ts";
import { AGENT_TOOLS, MESSAGE_AGENT_TOOL } from "./agent-tools.ts";
import type { AgentTeamOptions } from "./team-options.ts";

/** The tools every agent turn runs with: the plugins', plus the shell and agent tools. */
export function teamSelection(
	options: Pick<AgentTeamOptions, "pluginSelection" | "pluginTools">,
	scope?: AgentTurnScope,
): TurnSelection {
	const plugged = options.pluginSelection();
	return {
		id: "agent",
		tools: [
			...new Set([
				...plugged.tools,
				...SHELL_TOOLS,
				// Group members hand off by mentioning each other, so a group seat has no message_agent.
				...AGENT_TOOLS.filter(
					(tool) => !(scope?.group && tool === MESSAGE_AGENT_TOOL),
				),
				...(options.pluginTools?.() ?? []),
			]),
		],
		groups: plugged.groups,
	};
}
