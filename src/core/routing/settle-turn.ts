import type { ScheduledOutcome } from "../contract/channels.ts";
import { AgentRunError } from "../domain/errors.ts";

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

/** The result of a turn nobody wrote, as the scheduler and reports see it. */
export function outcome(
	result: { ok: true } | { ok: false; error: { message: string } },
): ScheduledOutcome {
	return result.ok
		? { status: "ran" }
		: { status: "failed", error: result.error.message };
}
