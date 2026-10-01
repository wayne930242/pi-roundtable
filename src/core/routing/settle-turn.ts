import type { ScheduledOutcome } from "../contract/channels.ts";
import type { TurnResult } from "../domain/conversation.ts";
import { AgentRunError } from "../domain/errors.ts";
import type { TurnEndEvent } from "../plugin.ts";

/** Runs a turn; a thrown error becomes its failed result, labelled `<what> crashed`. */
export async function settleTurn<R>(
	run: () => Promise<R>,
	what: string,
): Promise<R | { ok: false; error: AgentRunError }> {
	try {
		return await run();
	} catch (error) {
		return {
			ok: false,
			error: new AgentRunError(`${what} crashed: ${String(error)}`),
		};
	}
}

/** How a turn ended, as the `turnEnded` event reports it. */
export function endOf(result: TurnResult): TurnEndEvent["result"] {
	if (result.ok) return "ok";
	return result.stopped ? "stopped" : "failed";
}

/** The result of a turn nobody wrote, as the scheduler and reports see it. */
export function outcome(
	result: { ok: true } | { ok: false; error: { message: string } },
): ScheduledOutcome {
	return result.ok
		? { status: "ran" }
		: { status: "failed", error: result.error.message };
}
