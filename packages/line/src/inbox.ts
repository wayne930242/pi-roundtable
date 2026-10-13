import type { SQL } from "bun";
import type { Logger } from "pi-roundtable";
import { errorCode, LineError } from "./errors.ts";
import type { PgSources } from "./sources.ts";

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
const DEPENDENT = new Set(["unsend", "messageEdited"]);

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

interface Claimed {
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
interface Lease {
	/** `claimed_at` as the row holds it now, moved on by each renewal. */
	at: Date;
}

export interface InboxWorkerDeps {
	sql: SQL;
	logger: Logger;
	now: () => Date;
	sources: PgSources;
	/** The processor to hand events to; while there is none the worker claims nothing. */
	processor: () => InboxProcessor | undefined;
	options?: Partial<InboxOptions>;
	/** Replaces `Math.random`, for tests. */
	random?: () => number;
}

/**
 * Takes stored events one chat at a time, oldest event first, and hands them to the processor.
 * Delivery is at least once: a handler that outlives its lease (the worker's process died, or it
 * could not renew) may run again, so a processor must be idempotent.
 *
 * - A claim is `FOR UPDATE SKIP LOCKED` under a per-chat advisory lock, so two workers (or two
 *   processes) do not hold events of one chat together while leases are kept.
 * - A claimed event has a lease, which the worker renews while the handler runs; one still claimed
 *   when the lease ends goes back to waiting, and that is counted as a handing out, so an event that
 *   crashes its worker is eventually dead. Every write that ends a handling is fenced by its claim,
 *   so a handler that lost the event cannot change what the next claim wrote.
 * - Order is by LINE's event time among the events that are due; an event that is backing off does
 *   not hold the ones behind it, because a stuck head would then stall a whole chat. The events
 *   that act on a message wait, without limit, until the message and the earlier events on it are
 *   settled, so events of one message run strictly in order.
 * - Only the events of allowed chats (and the join, leave and unsend of any chat that is not blocked)
 *   are handed out; what a blocked chat still has waiting is dropped with its payload, and what a
 *   chat the bot left or one not decided has waiting is dropped too, apart from those three.
 * - A finished event keeps its row and loses its payload.
 */
export class InboxWorker {
	readonly #sql: SQL;
	readonly #logger: Logger;
	readonly #now: () => Date;
	readonly #sources: PgSources;
	readonly #processor: () => InboxProcessor | undefined;
	readonly #random: () => number;
	readonly options: InboxOptions;
	#running = false;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#wake = false;
	readonly #inflight = new Set<Promise<void>>();
	readonly #active = new Set<string>();
	/** One per handling in progress, aborted when the worker stops. */
	readonly #aborts = new Set<AbortController>();
	#stopping = false;
	#loop: Promise<void> | undefined;

	constructor(deps: InboxWorkerDeps) {
		this.#sql = deps.sql;
		this.#logger = deps.logger;
		this.#now = deps.now;
		this.#sources = deps.sources;
		this.#processor = deps.processor;
		this.#random = deps.random ?? Math.random;
		this.options = { ...INBOX_DEFAULTS, ...deps.options };
	}

	/** Event ids being handled now, one entry each, for the shutdown drain. */
	busy(): string[] {
		return [...this.#active];
	}

	/** Looks at the inbox now instead of at the next poll. */
	kick(): void {
		this.#wake = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
			this.#resume?.();
		}
	}

	#resume: (() => void) | undefined;

	/** Puts back events whose lease ran out; returns how many. */
	async recoverLeases(): Promise<number> {
		const now = this.#now();
		const expired = new Date(now.getTime() - this.options.leaseMs);
		// Events this worker is handling renew their own lease; it does not take them back.
		const own = JSON.stringify([...this.#active]);
		const rows: { attempts: number }[] = await this.#sql`UPDATE line_inbox
			SET status = CASE WHEN attempts >= ${this.options.maxAttempts} THEN 'dead' ELSE 'pending' END,
				next_attempt_at = ${now},
				claimed_at = NULL,
				payload = CASE WHEN attempts >= ${this.options.maxAttempts} THEN NULL ELSE payload END,
				completed_at = CASE WHEN attempts >= ${this.options.maxAttempts} THEN ${now}::timestamptz ELSE NULL::timestamptz END,
				last_error_code = 'lease_expired'
			WHERE status = 'processing' AND claimed_at < ${expired}
				AND webhook_event_id NOT IN (SELECT jsonb_array_elements_text(${own}::text::jsonb))
			RETURNING attempts`;
		if (rows.length > 0)
			this.#logger.warn(
				{ count: rows.length },
				"LINE inbox events put back after their lease ran out",
			);
		return rows.length;
	}

	/**
	 * Claims the oldest due event whose chat has none being handled, and hands it to the processor.
	 * Returns false when nothing was due (or there is no processor).
	 */
	async runOnce(): Promise<boolean> {
		const taken = await this.#take();
		if (!taken) return false;
		this.#active.add(taken.event.webhook_event_id);
		try {
			await this.#handle(taken.event, taken.processor);
		} finally {
			this.#active.delete(taken.event.webhook_event_id);
		}
		return true;
	}

	/**
	 * Claims the oldest due event and the processor to hand it to. The processor is looked up again
	 * after the claim, which takes time: one detached by then leaves the event waiting (not counted as a
	 * handing out), and one attached in the meantime is the one that gets it. Once `stop` has been
	 * called nothing is handed out, so an event claimed as it began goes back too.
	 */
	async #take(): Promise<
		{ event: Claimed; processor: InboxProcessor } | undefined
	> {
		if (!this.#processor()) return undefined;
		const event = await this.#claim();
		if (!event) return undefined;
		const processor = this.#processor();
		// A stop that began during the claim hands nothing out: the event waits for the next start.
		if (!processor || this.#stopping) {
			await this.#later(
				event,
				{ at: event.claimed_at },
				processor ? 0 : this.options.pollMs,
				processor ? "worker_stopped" : "no_processor",
				false,
			);
			return undefined;
		}
		return { event, processor };
	}

	async #claim(): Promise<Claimed | undefined> {
		const now = this.#now();
		return this.#sql.begin(async (tx) => {
			// A chat the bot left, or one not decided, hands out only its join, leave and unsend. What else
			// waits there (it was backing off when the chat changed) is dropped with its payload, because
			// it could otherwise surface much later, after a rejoin. An unsend carries no content and only
			// takes content down, so it is kept.
			await tx`UPDATE line_inbox i
				SET status = 'skipped', payload = NULL, last_error_code = CASE s.status WHEN 'left' THEN 'source_left' ELSE 'source_pending' END,
					completed_at = ${now}
				FROM line_sources s
				WHERE s.source_key = i.source_key AND s.status IN ('pending', 'left')
					AND i.status = 'pending' AND i.event_type NOT IN ('join', 'leave', 'unsend')`;
			// The oldest due event of each chat that has none in hand, and the events that name no chat.
			const heads: {
				webhook_event_id: string;
				source_key: string | null;
				event_ts: string | number;
				seq: string | number;
				source_status: string | null;
			}[] =
				await tx`(SELECT DISTINCT ON (i.source_key) i.webhook_event_id, i.source_key, i.event_ts, i.seq,
							s.status AS source_status
						FROM line_inbox i
						JOIN line_sources s ON s.source_key = i.source_key
						WHERE i.status = 'pending' AND i.next_attempt_at <= ${now} AND i.source_key IS NOT NULL
							AND (s.status IN ('allowed', 'blocked')
								OR (s.status IN ('pending', 'left') AND i.event_type IN ('join', 'leave', 'unsend')))
							AND NOT EXISTS (SELECT 1 FROM line_inbox p WHERE p.source_key = i.source_key AND p.status = 'processing')
						ORDER BY i.source_key, i.event_ts, i.seq)
					UNION ALL
					(SELECT i.webhook_event_id, i.source_key, i.event_ts, i.seq, NULL AS source_status FROM line_inbox i
						WHERE i.status = 'pending' AND i.next_attempt_at <= ${now} AND i.source_key IS NULL
						ORDER BY i.event_ts, i.seq LIMIT 20)`;
			heads.sort(
				(x, y) =>
					Number(x.event_ts) - Number(y.event_ts) ||
					Number(x.seq) - Number(y.seq),
			);
			for (const head of heads) {
				if (head.source_key) {
					// Every claimer takes the chat's lock before it looks at the chat's events, so none claims
					// an event that has an older one in front of it; a busy lock means another worker has the chat.
					const [lock] =
						(await tx`SELECT pg_try_advisory_xact_lock(hashtextextended(${head.source_key}, 7)) AS held`) as {
							held: boolean;
						}[];
					if (!lock?.held) continue;
					const [busy] = (await tx`SELECT 1 AS busy FROM line_inbox
						WHERE source_key = ${head.source_key} AND status = 'processing' LIMIT 1`) as unknown[];
					if (busy) continue;
					if (head.source_status === "blocked") {
						// What a blocked chat still has waiting is never handed out; the chat is left to the next look.
						await tx`UPDATE line_inbox
							SET status = 'skipped', payload = NULL, last_error_code = 'source_blocked', completed_at = ${now}
							WHERE source_key = ${head.source_key} AND status = 'pending'
								AND EXISTS (SELECT 1 FROM line_sources WHERE source_key = ${head.source_key} AND status = 'blocked')`;
						continue;
					}
				}
				// Locked, then claimed: a row another transaction holds (a block, say) is left to it.
				const claimed: Claimed[] = await tx`UPDATE line_inbox
					SET status = 'processing', claimed_at = ${now}, attempts = attempts + 1
					WHERE webhook_event_id = (
						SELECT webhook_event_id FROM line_inbox
						WHERE webhook_event_id = ${head.webhook_event_id} AND status = 'pending' AND next_attempt_at <= ${now}
						FOR UPDATE SKIP LOCKED)
					RETURNING seq, webhook_event_id, source_key, event_type, message_id, event_ts, payload,
						attempts, requeues, created_at, claimed_at`;
				if (claimed[0]) return claimed[0];
			}
			return undefined;
		});
	}

	async #handle(row: Claimed, processor: InboxProcessor): Promise<void> {
		const log = this.#logger.child({
			event: row.webhook_event_id,
			type: row.event_type,
			attempt: row.attempts,
		});
		const lease: Lease = { at: row.claimed_at };
		const controller = new AbortController();
		this.#aborts.add(controller);
		if (this.#stopping) controller.abort(stopped());
		const beat = this.#keepLease(row, lease, log, controller);
		try {
			const wait = await this.#mustWait(row);
			if (wait !== undefined) {
				await beat.stop();
				return await this.#later(
					row,
					lease,
					wait,
					"waiting_for_message",
					false,
				);
			}
			const timestamp = Number(row.event_ts);
			if (row.source_key && row.event_type === "join")
				await this.#sources.markJoined(row.source_key, timestamp);
			if (row.source_key && row.event_type === "leave")
				await this.#sources.markLeft(row.source_key, timestamp);
			const result = await this.#callProcessor(
				processor,
				{
					id: row.webhook_event_id,
					type: row.event_type,
					sourceKey: row.source_key,
					messageId: row.message_id,
					timestamp,
					payload: row.payload ?? {},
					attempt: row.attempts,
				},
				controller,
			);
			await beat.stop();
			if (result && Number.isFinite(result.retryInMs))
				return await this.#later(
					row,
					lease,
					Math.max(0, result.retryInMs),
					"retry_requested",
					true,
				);
			this.#settled(
				row,
				await this.#sql`UPDATE line_inbox
					SET status = 'done', payload = NULL, claimed_at = NULL, last_error_code = NULL, completed_at = ${this.#now()}
					WHERE webhook_event_id = ${row.webhook_event_id} AND status = 'processing' AND claimed_at = ${lease.at}
					RETURNING 1`,
			);
		} catch (error) {
			const code = errorCode(error);
			await beat.stop();
			// Whatever the handler threw on being told the worker stops is the restart's doing, not the
			// event's: it goes back without being counted. A timeout is the event's own.
			if (code !== "handler_timeout" && isStopped(controller.signal)) {
				await this.#later(row, lease, 0, "worker_stopped", false);
				return;
			}
			log.warn({ code }, "a LINE inbox event failed");
			await this.#fail(row, lease, code);
		} finally {
			await beat.stop();
			this.#aborts.delete(controller);
		}
	}

	/**
	 * Runs the processor for at most `maxHandleMs`. Past that its signal is aborted and the call
	 * fails with `handler_timeout` while the handler is left behind: whatever it settles with later
	 * is ignored, and its writes to the inbox are refused by the claim fence.
	 */
	async #callProcessor(
		processor: InboxProcessor,
		event: InboxEvent,
		controller: AbortController,
	): Promise<InboxResult> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const limit = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				const error = new LineError(
					"handler_timeout",
					`line: a handler ran past ${this.options.maxHandleMs} ms`,
				);
				controller.abort(error);
				reject(error);
			}, this.options.maxHandleMs);
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
	#keepLease(
		row: Claimed,
		lease: Lease,
		log: Logger,
		controller: AbortController,
	): { stop: () => Promise<void> } {
		let renewing: Promise<void> | undefined;
		let timer: ReturnType<typeof setInterval> | undefined;
		const renew = async () => {
			try {
				const next = this.#now();
				const rows: unknown[] = await this.#sql`UPDATE line_inbox
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
			Math.max(1, Math.floor(this.options.leaseMs / 3)),
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

	/** Logs a write that changed nothing: the event was no longer this handler's. */
	#settled(row: Claimed, rows: unknown[]): boolean {
		if (rows.length > 0) return true;
		this.#logger.warn(
			{ event: row.webhook_event_id, type: row.event_type },
			"a LINE inbox event was recovered while it was handled, so its outcome was dropped",
		);
		return false;
	}

	/**
	 * For an event that acts on a message: how long to wait when the message, or an earlier event on
	 * it, is not settled yet, or undefined when it may go on. Events of one message run in order:
	 * the message first, then its edits and unsends by LINE's time, each only once the ones before it
	 * are done or dead (an event backing off is not done). A message that is not in the inbox at all
	 * may still be on its way, so it is waited for until the grace is over; after that the processor
	 * decides. The wait lasts until the soonest event it waits for is due again, and at least
	 * `dependencyRetryMs`.
	 */
	async #mustWait(row: Claimed): Promise<number | undefined> {
		if (!DEPENDENT.has(row.event_type) || !row.message_id) return undefined;
		const found: {
			event_type: string;
			status: string;
			event_ts: string | number;
			seq: string | number;
			next_attempt_at: Date;
		}[] = await this
			.#sql`SELECT event_type, status, event_ts, seq, next_attempt_at FROM line_inbox
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
			const now = this.#now().getTime();
			return Math.min(
				...blockers.map((e) =>
					e.status === "pending"
						? Math.max(
								this.options.dependencyRetryMs,
								e.next_attempt_at.getTime() - now,
							)
						: this.options.dependencyRetryMs,
				),
			);
		}
		if (originals.length > 0) return undefined;
		const age = this.#now().getTime() - row.created_at.getTime();
		return age < this.options.messageGraceMs
			? this.options.dependencyRetryMs
			: undefined;
	}

	/**
	 * Drops the event when its chat was blocked while it was in hand, so it is never handed out
	 * again; true when it did.
	 */
	async #dropIfBlocked(row: Claimed, lease: Lease): Promise<boolean> {
		if (!row.source_key) return false;
		const [source] = (await this.#sql`SELECT status FROM line_sources
			WHERE source_key = ${row.source_key}`) as { status: string }[];
		if (source?.status !== "blocked") return false;
		this.#settled(
			row,
			await this.#sql`UPDATE line_inbox
				SET status = 'skipped', payload = NULL, claimed_at = NULL, last_error_code = 'source_blocked',
					completed_at = ${this.#now()}
				WHERE webhook_event_id = ${row.webhook_event_id} AND status = 'processing' AND claimed_at = ${lease.at}
				RETURNING 1`,
		);
		return true;
	}

	/**
	 * Back to waiting without a failure: the handing out is not counted. `counted` says whether the
	 * return counts towards `maxRequeues`; waiting for a message does not, because the message is
	 * settled by its own attempts and the wait must outlast them.
	 */
	async #later(
		row: Claimed,
		lease: Lease,
		delayMs: number,
		code: string,
		counted: boolean,
	): Promise<void> {
		if (await this.#dropIfBlocked(row, lease)) return;
		const now = this.#now();
		if (counted && row.requeues + 1 > this.options.maxRequeues) {
			await this.#die(row, lease, "requeue_limit");
			return;
		}
		this.#settled(
			row,
			await this.#sql`UPDATE line_inbox
				SET status = 'pending', claimed_at = NULL, attempts = attempts - 1,
					requeues = requeues + ${counted ? 1 : 0},
					next_attempt_at = ${new Date(now.getTime() + delayMs)}, last_error_code = ${code}
				WHERE webhook_event_id = ${row.webhook_event_id} AND status = 'processing' AND claimed_at = ${lease.at}
				RETURNING 1`,
		);
	}

	async #fail(row: Claimed, lease: Lease, code: string): Promise<void> {
		if (await this.#dropIfBlocked(row, lease)) return;
		if (row.attempts >= this.options.maxAttempts)
			return this.#die(row, lease, code);
		const delay = backoffMs(row.attempts, this.options, this.#random);
		this.#settled(
			row,
			await this.#sql`UPDATE line_inbox
				SET status = 'pending', claimed_at = NULL, last_error_code = ${code},
					next_attempt_at = ${new Date(this.#now().getTime() + delay)}
				WHERE webhook_event_id = ${row.webhook_event_id} AND status = 'processing' AND claimed_at = ${lease.at}
				RETURNING 1`,
		);
	}

	async #die(row: Claimed, lease: Lease, code: string): Promise<void> {
		const rows = await this.#sql`UPDATE line_inbox
			SET status = 'dead', payload = NULL, claimed_at = NULL, last_error_code = ${code}, completed_at = ${this.#now()}
			WHERE webhook_event_id = ${row.webhook_event_id} AND status = 'processing' AND claimed_at = ${lease.at}
			RETURNING 1`;
		if (!this.#settled(row, rows)) return;
		this.#logger.error(
			{ event: row.webhook_event_id, type: row.event_type, code },
			"a LINE inbox event is dead",
		);
	}

	/** Starts the loop: leases are recovered first, then events are handled as they come. */
	async start(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		this.#stopping = false;
		await this.recoverLeases();
		this.#loop = this.#run();
	}

	async #run(): Promise<void> {
		let lastSweep = this.#now().getTime();
		while (this.#running) {
			try {
				if (this.#now().getTime() - lastSweep >= this.options.leaseMs / 2) {
					lastSweep = this.#now().getTime();
					await this.recoverLeases();
				}
				await this.#fill();
			} catch (error) {
				this.#logger.error(
					{ code: errorCode(error) },
					"the LINE inbox worker could not read the inbox",
				);
			}
			if (!this.#running) break;
			if (this.#wake) {
				this.#wake = false;
				continue;
			}
			await new Promise<void>((resolve) => {
				this.#resume = resolve;
				this.#timer = setTimeout(resolve, this.options.pollMs);
			});
			this.#timer = undefined;
			this.#resume = undefined;
		}
	}

	/**
	 * Hands due events out until every slot of `concurrency` is taken or none is due. The loop comes
	 * back on a kick, on a poll and whenever a handler ends, so a slow handler holds one slot only.
	 */
	async #fill(): Promise<void> {
		while (this.#running && this.#inflight.size < this.options.concurrency)
			if (!(await this.#startOne())) break;
	}

	/** Claims one event and runs it in the background; false when none was due. */
	async #startOne(): Promise<boolean> {
		const taken = await this.#take();
		if (!taken) return false;
		const { event, processor } = taken;
		this.#active.add(event.webhook_event_id);
		const task: Promise<void> = this.#handle(event, processor)
			.catch((error) =>
				this.#logger.error(
					{ code: errorCode(error) },
					"a LINE inbox event could not be recorded",
				),
			)
			.finally(() => {
				this.#active.delete(event.webhook_event_id);
				this.#inflight.delete(task);
				// The slot is free: look at the inbox again now instead of at the next poll.
				this.kick();
			});
		this.#inflight.add(task);
		return true;
	}

	/**
	 * Stops claiming, aborts the signals of the handlers in hand and waits for them to settle. A
	 * handler that ignores its signal is waited for, up to `maxHandleMs`.
	 */
	async stop(): Promise<void> {
		this.#running = false;
		this.#stopping = true;
		for (const controller of this.#aborts) controller.abort(stopped());
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
			this.#resume?.();
		}
		await this.#loop;
		this.#loop = undefined;
		await Promise.allSettled([...this.#inflight]);
	}
}

function stopped(): LineError {
	return new LineError("worker_stopped", "line: the inbox worker is stopping");
}

function isStopped(signal: AbortSignal): boolean {
	return signal.aborted && errorCode(signal.reason) === "worker_stopped";
}
