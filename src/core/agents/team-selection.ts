import type { AgentTurnScope } from "../domain/ports.ts";
import { SHELL_TOOLS } from "../modules/host-shell/shell-policy.ts";
import type { TurnSelection } from "../sessions.ts";
import { isHelper } from "./agent-rules.ts";
import {
	AGENT_TOOLS,
	HELPER_TOOLS,
	MESSAGE_AGENT_TOOL,
	WITHHELD_FROM_HELPERS,
} from "./agent-tools.ts";
import type { AgentTeamOptions } from "./team-options.ts";

/** The tools every agent turn runs with: the plugins', plus the shell and agent tools. */
export function teamSelection(
	options: Pick<
		AgentTeamOptions,
		"pluginSelection" | "pluginTools" | "agentTools" | "helpers"
	> & { store?: Pick<AgentTeamOptions["store"], "agent"> },
	scope?: AgentTurnScope,
): TurnSelection {
	const plugged = options.pluginSelection();
	// A temp knight cannot make knights, groups or schedules, nor archive anything: the tools are
	// not offered to its turns, which stops a chain of them multiplying.
	const helper =
		scope !== undefined && isHelper(options.store?.agent(scope.name));
	const kept = (tool: string): boolean =>
		!(helper && WITHHELD_FROM_HELPERS.includes(tool)) &&
		!(
			options.helpers === false &&
			(HELPER_TOOLS as readonly string[]).includes(tool)
		);
	return {
		id: "agent",
		tools: [
			...new Set(
				[
					...plugged.tools,
					// A chat-only host's agents carry no shell and no file tools.
					...(options.agentTools === "chat-only" ? [] : SHELL_TOOLS),
					// Group members hand off by mentioning each other, so a group seat has no message_agent.
					...AGENT_TOOLS.filter(
						(tool) => !(scope?.group && tool === MESSAGE_AGENT_TOOL),
					),
					...(options.pluginTools?.() ?? []),
				].filter(kept),
			),
		],
		groups: plugged.groups,
	};
}
