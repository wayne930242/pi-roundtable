/** One stored event as the processor sees it. */
export interface InboxEvent {
	id: string;
	type: string;
	sourceKey: string | null;
	messageId: string | null;
	/** LINE's event time, milliseconds since the epoch. */
	timestamp: number;
	/** The event as LINE sent it. */
	payload: Record<string, unknown>;
	/** How many times this event has been handed out, this one included. */
	attempt: number;
}

/**
 * What a processor answers: nothing (or `undefined`) when the event is done, `{ retryInMs }` to
 * look at it again later without counting a failure. A thrown error is a failure: the event is
 * retried with backoff and, after `maxAttempts` handings out, set aside as dead. Only the error's
 * `code` word is stored, never its message.
 */
export type InboxResult = undefined | { retryInMs: number };
export type InboxProcessor = (
	event: InboxEvent,
	/**
	 * Aborted when the handler has run `maxHandleMs`, when the worker stops, and when the worker
	 * finds the event is no longer its own (the lease was lost); give up whatever it waits on.
	 * `signal.reason` is a `LineError` coded `handler_timeout`, `worker_stopped` or `lease_lost`.
	 * To give up, throw (`throw signal.reason`, or the abort error a fetch rejects with) or return
	 * `{ retryInMs }`: returning `undefined` means the event was handled, and it is marked done.
	 */
	signal: AbortSignal,
) => Promise<InboxResult>;

export interface InboxOptions {
	/** How long a claimed event may take before another worker may take it; default 2 minutes. At most 2_147_483_647. */
	leaseMs: number;
	/**
	 * Longest a handler may run, renewals included; default 10 minutes. Past it the processor's signal
	 * is aborted, the lease is no longer renewed and the event fails with `handler_timeout` (retried
	 * with backoff, dead after `maxAttempts`), so a handler that never settles cannot hold its chat or
	 * the shutdown. At most 2_147_483_647, the longest delay a timer can hold.
	 */
	maxHandleMs: number;
	/** Handings out after which a failing event is dead; default 12. */
	maxAttempts: number;
	/** Retries that asked for later (`retryInMs`) before the event is dead; default 720. */
	maxRequeues: number;
	/** First backoff; each failure doubles it, up to `backoffCapMs`; default 5 seconds. */
	backoffBaseMs: number;
	/** Longest backoff; default 1 hour. */
	backoffCapMs: number;
	/** Events handled at once, always of different chats; default 2. */
	concurrency: number;
	/** How long the worker waits between looks at the inbox when nothing woke it; default 2 seconds. At most 2_147_483_647. */
	pollMs: number;
	/** How long a `unsend` or edit waits for a message that has not reached the inbox; default 10 minutes. */
	messageGraceMs: number;
	/** How long an event waits for the message it depends on while that message is in the inbox; default 5 seconds. */
	dependencyRetryMs: number;
}

export const INBOX_DEFAULTS: InboxOptions = {
	leaseMs: 2 * 60_000,
	maxHandleMs: 10 * 60_000,
	maxAttempts: 12,
	maxRequeues: 720,
	backoffBaseMs: 5_000,
	backoffCapMs: 60 * 60_000,
	concurrency: 2,
	pollMs: 2_000,
	messageGraceMs: 10 * 60_000,
	dependencyRetryMs: 5_000,
};

/** The events that act on a message an earlier event brought. */
export const DEPENDENT = new Set(["unsend", "messageEdited"]);

/**
 * Exponential backoff with jitter: the delay doubles with each failure up to the cap, and the
 * jitter spreads it over its upper half so a burst of failures does not retry in step.
 */
export function backoffMs(
	attempt: number,
	options: Pick<InboxOptions, "backoffBaseMs" | "backoffCapMs">,
	random: () => number = Math.random,
): number {
	const exponent = Math.min(Math.max(attempt - 1, 0), 30);
	const raw = Math.min(
		options.backoffCapMs,
		options.backoffBaseMs * 2 ** exponent,
	);
	return Math.round(raw * (0.5 + random() * 0.5));
}

export interface Claimed {
	seq: string | number;
	webhook_event_id: string;
	source_key: string | null;
	event_type: string;
	message_id: string | null;
	event_ts: string | number;
	payload: Record<string, unknown> | null;
	attempts: number;
	requeues: number;
	created_at: Date;
	claimed_at: Date;
}

/** The claim an event is handled under; every write that ends the handling is fenced by it. */
export interface Lease {
	/** `claimed_at` as the row holds it now, moved on by each renewal. */
	at: Date;
}
