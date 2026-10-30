import { AgentError } from "../domain/errors.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import { agentSystemPrompt, placeOf } from "./agent-prompt.ts";
import type { Agent } from "./agent-store.ts";
import { coordinatorOf } from "./team-keys.ts";
import type { AgentTeamOptions } from "./team-options.ts";
import type { TeamTurns } from "./team-turns.ts";

/**
 * The system prompt addition of an agent session, read before each of its runs: the base every
 * agent turn starts with, then what the plugins' prompt sections add. `images` is whether the
 * agent can generate pictures.
 */
export function teamSystemPrompt(
	options: AgentTeamOptions,
	turns: Pick<TeamTurns, "speakerOf" | "turnChannel">,
	images: boolean,
	scope: AgentTurnScope,
): string {
	const {
		store,
		workDir,
		sharedPrompt,
		guestPrompt,
		owner,
		shellUser,
		scratchDir,
		agentTools,
		surfaces,
		channels,
	} = options;
	const agent = store.agent(scope.name);
	if (!agent) throw new AgentError(`no agent ${scope.name}`);
	const shared =
		typeof sharedPrompt === "function" ? sharedPrompt() : sharedPrompt;
	const guest = typeof guestPrompt === "function" ? guestPrompt() : guestPrompt;
	const group = scope.group ? store.group(scope.group) : undefined;
	const coordinator = coordinatorOf(store, options);
	const speaker = turns.speakerOf(scope);
	const base = agentSystemPrompt({
		agent,
		...(speaker ? { speaker } : {}),
		...(coordinator ? { coordinator } : {}),
		shared,
		...(guest ? { guestShared: guest } : {}),
		workDir,
		owner,
		shellUser,
		...(scratchDir ? { scratchDir } : {}),
		images,
		...(agent.parent ? { parent: store.agent(agent.parent) } : {}),
		helpers: options.helpers !== false,
		...(agentTools ? { agentTools } : {}),
		...placeOf(turns.turnChannel(scope), surfaces, !!channels),
		...(group
			? {
					group: {
						group,
						members: group.members
							.map((m) => store.agent(m))
							.filter((m): m is Agent => m !== undefined),
					},
				}
			: {}),
	});
	const added = (options.promptSections?.() ?? []).flatMap(
		(section) =>
			section.build({
				agent: { name: agent.name, displayName: agent.displayName },
				speaker,
				scope,
			}) ?? [],
	);
	return [base, ...added.filter((text) => text.trim() !== "")].join("\n\n");
}
