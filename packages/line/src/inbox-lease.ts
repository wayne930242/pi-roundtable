import type { SQL } from "bun";
import type { Logger } from "pi-roundtable";
import { errorCode, LineError } from "./errors.ts";
import type {
	Claimed,
	InboxEvent,
	InboxProcessor,
	InboxResult,
	Lease,
} from "./inbox-types.ts";

/**
 * Runs the processor for at most `maxHandleMs`. Past that its signal is aborted and the call
 * fails with `handler_timeout` while the handler is left behind: whatever it settles with later
 * is ignored, and its writes to the inbox are refused by the claim fence.
 */
export async function callProcessor(
	processor: InboxProcessor,
	event: InboxEvent,
	controller: AbortController,
	maxHandleMs: number,
): Promise<InboxResult> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const limit = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			const error = new LineError(
				"handler_timeout",
				`line: a handler ran past ${maxHandleMs} ms`,
			);
			controller.abort(error);
			reject(error);
		}, maxHandleMs);
	});
	try {
		return await Promise.race([
			Promise.resolve().then(() => processor(event, controller.signal)),
			limit,
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Renews the claim while the handler runs, so a slow handler (an upload, say) is not taken for a
 * crashed one. A renewal that finds the claim changed means the event was recovered by someone
 * else: the heartbeat stops, the handler's signal is aborted and its last write will be refused.
 */
export function keepLease(
	sql: SQL,
	now: () => Date,
	leaseMs: number,
	row: Claimed,
	lease: Lease,
	log: Logger,
	controller: AbortController,
): { stop: () => Promise<void> } {
	let renewing: Promise<void> | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	const renew = async () => {
		try {
			const next = now();
			const rows: unknown[] = await sql`UPDATE line_inbox
				SET claimed_at = ${next}
				WHERE webhook_event_id = ${row.webhook_event_id} AND status = 'processing' AND claimed_at = ${lease.at}
				RETURNING 1`;
			if (rows.length > 0) {
				lease.at = next;
				return;
			}
			log.warn({}, "a LINE inbox event lost its lease while it was handled");
			controller.abort(
				new LineError(
					"lease_lost",
					"line: the event is no longer this worker's",
				),
			);
		} catch (error) {
			log.warn(
				{ code: errorCode(error) },
				"a LINE inbox lease could not be renewed",
			);
			return;
		}
		if (timer) clearInterval(timer);
		timer = undefined;
	};
	timer = setInterval(
		() => {
			renewing ??= renew().finally(() => {
				renewing = undefined;
			});
		},
		Math.max(1, Math.floor(leaseMs / 3)),
	);
	timer.unref?.();
	return {
		stop: async () => {
			if (timer) clearInterval(timer);
			timer = undefined;
			await renewing;
		},
	};
}
