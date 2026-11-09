import type { SQL } from "bun";
import { type Claimed, DEPENDENT, type InboxOptions } from "./inbox-types.ts";

/**
 * For an event that acts on a message: how long to wait when the message, or an earlier event on
 * it, is not settled yet, or undefined when it may go on. Events of one message run in order:
 * the message first, then its edits and unsends by LINE's time, each only once the ones before it
 * are done or dead (an event backing off is not done). A message that is not in the inbox at all
 * may still be on its way, so it is waited for until the grace is over; after that the processor
 * decides. The wait lasts until the soonest event it waits for is due again, and at least
 * `dependencyRetryMs`.
 */
export async function mustWait(
	sql: SQL,
	clock: () => Date,
	options: Pick<InboxOptions, "dependencyRetryMs" | "messageGraceMs">,
	row: Claimed,
): Promise<number | undefined> {
	if (!DEPENDENT.has(row.event_type) || !row.message_id) return undefined;
	const found: {
		event_type: string;
		status: string;
		event_ts: string | number;
		seq: string | number;
		next_attempt_at: Date;
	}[] =
		await sql`SELECT event_type, status, event_ts, seq, next_attempt_at FROM line_inbox
		WHERE message_id = ${row.message_id} AND source_key IS NOT DISTINCT FROM ${row.source_key}::text
			AND webhook_event_id <> ${row.webhook_event_id}
			AND (event_type = 'message' OR event_type IN ('unsend', 'messageEdited'))`;
	const open = (e: { status: string }) =>
		e.status === "pending" || e.status === "processing";
	const before = (e: { event_ts: string | number; seq: string | number }) =>
		Number(e.event_ts) < Number(row.event_ts) ||
		(Number(e.event_ts) === Number(row.event_ts) &&
			Number(e.seq) < Number(row.seq));
	const originals = found.filter((e) => e.event_type === "message");
	const blockers = found.filter(
		(e) => open(e) && (e.event_type === "message" || before(e)),
	);
	if (blockers.length > 0) {
		// Nothing changes before the soonest blocker is due again, so wait for that instead of polling
		// an event that is backing off for up to an hour; one being handled is looked at again soon.
		const now = clock().getTime();
		return Math.min(
			...blockers.map((e) =>
				e.status === "pending"
					? Math.max(
							options.dependencyRetryMs,
							e.next_attempt_at.getTime() - now,
						)
					: options.dependencyRetryMs,
			),
		);
	}
	if (originals.length > 0) return undefined;
	const age = clock().getTime() - row.created_at.getTime();
	return age < options.messageGraceMs ? options.dependencyRetryMs : undefined;
}
