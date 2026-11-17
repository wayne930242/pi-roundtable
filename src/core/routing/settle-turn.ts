import type { ScheduledOutcome } from "../contract/channels.ts";
import type { TurnResult } from "../domain/conversation.ts";
import { AgentRunError } from "../domain/errors.ts";
import { HostStoppingError } from "../kernel/errors.ts";
import type { TurnEndEvent } from "../plugin-api/plugin.ts";
import { currentRecord } from "./turn-records.ts";

/**
 * Runs a turn; a thrown error becomes its failed result, labelled `<what> crashed`. Run in the
 * work of a message's admission while that is open, its `run` or what it started, awaited or not,
 * such as a queue task, an `ok` result counts as the answer to that message, and a turn that ends
 * after a shutdown left the message for the next process gives a stopped result instead.
 */
export async function settleTurn<R>(
	run: () => Promise<R>,
	what: string,
): Promise<R | { ok: false; error: AgentRunError }> {
	const record = currentRecord();
	record?.begin();
	let result: R | { ok: false; error: AgentRunError };
	try {
		result = await run();
	} catch (error) {
		// A turn refused because the host stops leaves its message, as a cut one does.
		if (error instanceof HostStoppingError) record?.refusedByHost();
		result = {
			ok: false,
			error: new AgentRunError(`${what} crashed: ${String(error)}`),
		};
	}
	if (!record) return result;
	const settled = record.settle(result);
	record.end();
	return settled;
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
