import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import type { Speaker } from "../speakers.ts";
import { OWNER_SPEAKER } from "../testing/owner.ts";
import { agentChannel, fx, settle } from "./agent-team-fixture.ts";

export { settle };

export const SCOUT = {
	displayName: "Scout One",
	prompt: "You look one thing up.",
	task: "Look up the first paper.",
};

/** The scope of an agent's turn in its own Discord channel. */
export const scopeOf = (name: string): AgentTurnScope => ({
	name,
	session: agentChannel(name),
	home: agentChannel(name),
});

/** The owner's message to an agent, answered in its own place through the channel's queue. */
export const writeTo = (name: string, text: string) =>
	fx.queue.run(agentChannel(name), () =>
		fx.team.answerOwner(
			agentChannel(name),
			OWNER_SPEAKER,
			text,
			text,
			NO_ATTACHMENTS,
		),
	);

/**
 * Runs `action` during the next turn of the agent `name` in its own place, as the model calls a
 * tool, after the work already running has settled, and waits for what the action started.
 */
export async function inTurn<T>(
	name: string,
	action: (caller: AgentTurnScope) => Promise<T>,
	speaker: Speaker = OWNER_SPEAKER,
	via: string = name,
): Promise<T> {
	await settle();
	let outcome: { value: T } | { error: unknown } | undefined;
	fx.runtime.during = async (request) => {
		if (request.agent?.name !== name) return;
		fx.runtime.during = undefined;
		outcome = await action(scopeOf(name)).then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		);
	};
	// Through the channel's queue, as the host runs it, so what the turn starts waits for its end.
	await fx.queue.run(agentChannel(via), () =>
		fx.team.answerOwner(agentChannel(via), speaker, "go", "go", NO_ATTACHMENTS),
	);
	fx.runtime.during = undefined;
	await settle();
	if (!outcome) throw new Error(`no turn of ${name} ran the action`);
	if ("error" in outcome) throw outcome.error;
	return outcome.value;
}

/** Runs `action` inside the coordinator's turn. */
export const asCoordinator = <T>(
	action: (caller: AgentTurnScope) => Promise<T>,
) => inTurn("coordinator", action);

/** The text of every turn the runtime ran, by the agent that ran it. */
export const turnsOf = (name: string) =>
	fx.runtime.turns.filter((turn) => turn.agent?.name === name);
