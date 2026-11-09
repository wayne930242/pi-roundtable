import type { SQL } from "bun";
import type { Logger } from "pi-roundtable";
import { errorCode, LineError } from "./errors.ts";
import { claimNext } from "./inbox-claim.ts";
import { callProcessor, keepLease } from "./inbox-lease.ts";
import {
	backoffMs,
	type Claimed,
	INBOX_DEFAULTS,
	type InboxOptions,
	type InboxProcessor,
	type Lease,
} from "./inbox-types.ts";
import { mustWait } from "./inbox-wait.ts";
import type { PgSources } from "./sources.ts";

export {
	backoffMs,
	INBOX_DEFAULTS,
	type InboxEvent,
	type InboxOptions,
	type InboxProcessor,
	type InboxResult,
} from "./inbox-types.ts";

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
		const event = await claimNext(this.#sql, this.#now());
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
		const beat = keepLease(
			this.#sql,
			this.#now,
			this.options.leaseMs,
			row,
			lease,
			log,
			controller,
		);
		try {
			const wait = await mustWait(this.#sql, this.#now, this.options, row);
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
			// The waits above take time too: a processor detached or replaced meanwhile gets nothing,
			// and the event waits, uncounted, for the one attached now.
			if (this.#processor() !== processor) {
				await beat.stop();
				return await this.#later(
					row,
					lease,
					this.options.pollMs,
					"no_processor",
					false,
				);
			}
			const result = await callProcessor(
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
				this.options.maxHandleMs,
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
			// Giving up on being told the worker stops is the restart's doing, not the event's: it goes
			// back without being counted. Any other error the handler throws meanwhile is its own, and so
			// is a timeout.
			if (isStopped(controller.signal) && gaveUp(error, controller.signal)) {
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

/** The handler threw the signal's reason, an abort, or a `worker_stopped` error of its own. */
function gaveUp(error: unknown, signal: AbortSignal): boolean {
	return (
		error === signal.reason ||
		errorCode(error) === "worker_stopped" ||
		(error instanceof Error && error.name === "AbortError")
	);
}

function isStopped(signal: AbortSignal): boolean {
	return signal.aborted && errorCode(signal.reason) === "worker_stopped";
}
