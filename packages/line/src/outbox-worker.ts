import type { SQL } from "bun";
import type { Logger } from "pi-roundtable";
import type { LineApi } from "./api.ts";
import { errorCode, LineError } from "./errors.ts";
import { parseSourceKey } from "./events.ts";
import { backoffMs } from "./inbox.ts";
import type { LineOutboxResultEvent } from "./messages.ts";
import { OUTBOX_DEFAULTS, type OutboxOptions } from "./outbox.ts";
import type { QuotaGate } from "./quota.ts";
import type { LineSources } from "./sources.ts";

/** Attempts to tell the subscriber how a push ended, before it is given up. */
const MAX_NOTIFY_ATTEMPTS = 12;

interface Claimed {
	id: string | number;
	source_key: string;
	sender_name: string | null;
	sender_icon_url: string | null;
	messages: Record<string, unknown>[];
	retry_key: string;
	attempts: number;
	first_attempt_at: Date | null;
	claimed_at: Date;
}

export interface OutboxWorkerDeps {
	sql: SQL;
	logger: Logger;
	now: () => Date;
	api: LineApi;
	quota: QuotaGate;
	sources: LineSources;
	/**
	 * Tells the subscriber how a push ended; answers false when there is none to tell, and the result
	 * waits. Rejecting means the subscriber failed, and it is told again later.
	 */
	emit: (event: LineOutboxResultEvent, signal: AbortSignal) => Promise<boolean>;
	options?: Partial<OutboxOptions>;
	random?: () => number;
}

/**
 * Sends the queued pushes, the oldest of each chat first and one at a time per chat, and tells the
 * subscriber how each ended.
 *
 * - A push is tried under the retry key it was created with, on every attempt and after a crash, until
 *   it is accepted or the key is 24 hours old; past that it is dead, never sent under a new key.
 * - `2xx` and `409` (LINE has this key already) are `sent`; `429`, `5xx` and no answer back off and
 *   retry; any other `4xx` is `dead` with the code LINE's refusal maps to; a push the quota gate
 *   refuses is `refused`. Nothing but a code is kept of a failure.
 * - A push in hand has a lease the worker's own process does not outlive; one left in hand by a dead
 *   process goes back to waiting and is sent again under the same key.
 * - A finished push loses its message objects.
 */
export class OutboxWorker {
	readonly #sql: SQL;
	readonly #logger: Logger;
	readonly #now: () => Date;
	readonly #api: LineApi;
	readonly #quota: QuotaGate;
	readonly #sources: LineSources;
	readonly #emit: OutboxWorkerDeps["emit"];
	readonly #random: () => number;
	readonly options: OutboxOptions;
	#running = false;
	#stopping = false;
	#loop: Promise<void> | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#resume: (() => void) | undefined;
	#wake = false;
	readonly #inflight = new Set<Promise<void>>();
	readonly #active = new Set<string>();
	readonly #aborts = new Set<AbortController>();
	#notifying: Promise<number> | undefined;

	constructor(deps: OutboxWorkerDeps) {
		this.#sql = deps.sql;
		this.#logger = deps.logger;
		this.#now = deps.now;
		this.#api = deps.api;
		this.#quota = deps.quota;
		this.#sources = deps.sources;
		this.#emit = deps.emit;
		this.#random = deps.random ?? Math.random;
		this.options = { ...OUTBOX_DEFAULTS, ...deps.options };
	}

	/** Push ids being sent now, for the shutdown drain. */
	busy(): string[] {
		return [...this.#active];
	}

	/** Looks at the outbox now instead of at the next poll. */
	kick(): void {
		this.#wake = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
			this.#resume?.();
		}
	}

	/** Looks at the outbox in `delayMs`, when a push that is gathering becomes ready. */
	kickIn(delayMs: number): void {
		const timer = setTimeout(() => this.kick(), delayMs + 1);
		timer.unref?.();
	}

	/** Puts back pushes whose lease ran out; returns how many. */
	async recoverLeases(): Promise<number> {
		const now = this.#now();
		const expired = new Date(now.getTime() - this.options.leaseMs);
		const own = JSON.stringify([...this.#active]);
		const rows: unknown[] = await this.#sql`UPDATE line_outbox
			SET status = 'queued', claimed_at = NULL, next_attempt_at = ${now}, last_error_code = 'lease_expired'
			WHERE status = 'sending' AND claimed_at < ${expired}
				AND id::text NOT IN (SELECT jsonb_array_elements_text(${own}::text::jsonb))
			RETURNING 1`;
		if (rows.length > 0)
			this.#logger.warn(
				{ count: rows.length },
				"LINE pushes put back after their lease ran out",
			);
		return rows.length;
	}

	/** Claims the oldest due push of a chat that has none in hand. */
	async #claim(): Promise<Claimed | undefined> {
		const now = this.#now();
		return this.#sql.begin(async (tx) => {
			const [head] = (await tx`WITH heads AS (
					SELECT DISTINCT ON (source_key) id, status, ready_at, next_attempt_at
					FROM line_outbox WHERE status IN ('queued', 'sending')
					ORDER BY source_key, id)
				SELECT id FROM heads
				WHERE status = 'queued' AND ready_at <= ${now} AND next_attempt_at <= ${now}
				ORDER BY id LIMIT 1`) as { id: string | number }[];
			if (!head) return undefined;
			const [claimed] = (await tx`UPDATE line_outbox
				SET status = 'sending', claimed_at = ${now}, attempts = attempts + 1,
					first_attempt_at = COALESCE(first_attempt_at, ${now})
				WHERE id = (SELECT id FROM line_outbox WHERE id = ${head.id} AND status = 'queued' FOR UPDATE SKIP LOCKED)
				RETURNING id, source_key, sender_name, sender_icon_url, messages, retry_key, attempts,
					first_attempt_at, claimed_at`) as Claimed[];
			return claimed;
		});
	}

	/** Sends the oldest due push; returns false when none was due. For tests and for the loop. */
	async runOnce(): Promise<boolean> {
		const row = await this.#claim();
		if (!row) return false;
		const id = String(row.id);
		this.#active.add(id);
		try {
			await this.#handle(row);
		} finally {
			this.#active.delete(id);
		}
		return true;
	}

	async #handle(row: Claimed): Promise<void> {
		const log = this.#logger.child({
			push: String(row.id),
			attempt: row.attempts,
		});
		const controller = new AbortController();
		this.#aborts.add(controller);
		if (this.#stopping) controller.abort(stopped());
		const now = this.#now().getTime();
		try {
			// The key of a first attempt is new; one older than LINE keeps it is dead rather than resent.
			if (
				row.attempts > 1 &&
				row.first_attempt_at &&
				now - row.first_attempt_at.getTime() > this.options.retryKeyMs
			)
				return await this.#finish(row, "dead", "retry_key_expired", log);
			if ((await this.#sources.get(row.source_key))?.status !== "allowed")
				return await this.#finish(row, "dead", "source_not_allowed", log);
			const source = parseSourceKey(row.source_key);
			if (!source)
				return await this.#finish(row, "dead", "bad_source_key", log);
			const recipients = await this.#quota.recipients(row.source_key);
			const reserved = await this.#quota.reserve(recipients);
			if (!reserved.ok) {
				log.warn(
					{
						used: reserved.used,
						reserved: reserved.reserved,
						recipients: reserved.recipients,
						cap: reserved.cap,
					},
					"a LINE push was refused by the quota gate",
				);
				return await this.#finish(
					row,
					"refused",
					"quota_exhausted",
					log,
					recipients,
				);
			}
			let sent = false;
			try {
				const sender = {
					...(row.sender_name ? { name: row.sender_name } : {}),
					...(row.sender_icon_url ? { iconUrl: row.sender_icon_url } : {}),
				};
				const messages = row.messages.map((message) =>
					Object.keys(sender).length > 0 ? { ...message, sender } : message,
				);
				const pushed = await this.#api.push(
					source.id,
					messages,
					row.retry_key,
					controller.signal,
				);
				if (pushed.outcome === "sent") {
					sent = true;
					return await this.#finish(
						row,
						"sent",
						null,
						log,
						recipients,
						pushed.requestId,
					);
				}
				if (pushed.status === 429 || pushed.status >= 500)
					return await this.#retry(row, log, pushed.code, pushed.retryAfterMs);
				return await this.#finish(
					row,
					"dead",
					pushed.code,
					log,
					recipients,
					pushed.requestId,
				);
			} finally {
				this.#quota.settle(reserved.reservation, sent);
			}
		} catch (error) {
			// Giving up because the worker stops is the restart's doing: the push goes back as it was.
			if (this.#stopping && controller.signal.aborted) {
				await this.#later(row, 0, "worker_stopped", false);
				return;
			}
			const code = errorCode(error);
			log.warn({ code }, "a LINE push could not be sent");
			await this.#retry(row, log, code);
		} finally {
			this.#aborts.delete(controller);
		}
	}

	/** Ends a push: its objects are dropped and the subscriber is told when it can be. */
	async #finish(
		row: Claimed,
		status: "sent" | "dead" | "refused",
		code: string | null,
		log: Logger,
		recipients?: number,
		requestId?: string,
	): Promise<void> {
		const rows: unknown[] = await this.#sql`UPDATE line_outbox
			SET status = ${status}, messages = NULL, claimed_at = NULL, completed_at = ${this.#now()},
				last_error_code = ${code}, line_request_id = ${requestId ?? null}, recipients = ${recipients ?? null}
			WHERE id = ${row.id} AND status = 'sending' AND claimed_at = ${row.claimed_at}
			RETURNING 1`;
		if (rows.length === 0) {
			log.warn(
				{},
				"a LINE push was recovered while it was sent, so its outcome was dropped",
			);
			return;
		}
		if (status === "sent") log.info({}, "a LINE push was sent");
		else log.warn({ code, status }, "a LINE push did not go out");
		this.kick();
	}

	/** Backs off after a failure, or ends the push when it has failed `maxAttempts` times. */
	async #retry(
		row: Claimed,
		log: Logger,
		code: string,
		retryAfterMs?: number,
	): Promise<void> {
		if (row.attempts >= this.options.maxAttempts)
			return this.#finish(row, "dead", code, log);
		const delay = Math.max(
			backoffMs(row.attempts, this.options, this.#random),
			retryAfterMs ?? 0,
		);
		await this.#later(row, delay, code, true);
	}

	async #later(
		row: Claimed,
		delayMs: number,
		code: string,
		counted: boolean,
	): Promise<void> {
		await this.#sql`UPDATE line_outbox
			SET status = 'queued', claimed_at = NULL, attempts = attempts - ${counted ? 0 : 1},
				next_attempt_at = ${new Date(this.#now().getTime() + delayMs)}, last_error_code = ${code}
			WHERE id = ${row.id} AND status = 'sending' AND claimed_at = ${row.claimed_at}`;
	}

	/**
	 * Tells the subscriber how finished pushes ended, oldest first, once each per origin; a push
	 * whose telling fails is tried again later, up to 12 times. Returns how many pushes were told.
	 */
	notify(): Promise<number> {
		this.#notifying ??= this.#notify().finally(() => {
			this.#notifying = undefined;
		});
		return this.#notifying;
	}

	async #notify(): Promise<number> {
		const now = this.#now();
		const rows: {
			id: string | number;
			source_key: string;
			status: "sent" | "dead" | "refused";
			last_error_code: string | null;
			origin_refs: (string | null)[];
			notify_attempts: number;
		}[] = await this
			.#sql`SELECT id, source_key, status, last_error_code, origin_refs, notify_attempts
			FROM line_outbox
			WHERE notified_at IS NULL AND status IN ('sent', 'dead', 'refused')
				AND (notify_after IS NULL OR notify_after <= ${now})
			ORDER BY id LIMIT 20`;
		let told = 0;
		const controller = new AbortController();
		this.#aborts.add(controller);
		if (this.#stopping) controller.abort(stopped());
		try {
			for (const row of rows) {
				if (controller.signal.aborted) break;
				try {
					const origins = row.origin_refs.length > 0 ? row.origin_refs : [null];
					let heard = true;
					for (const originRef of origins) {
						heard = await this.#emit(
							{
								type: "outboxResult",
								sourceKey: row.source_key,
								originRef,
								status: row.status,
								errorCode: row.last_error_code,
							},
							controller.signal,
						);
						if (!heard) break;
					}
					// No subscriber: the results wait for one.
					if (!heard) break;
					await this
						.#sql`UPDATE line_outbox SET notified_at = ${this.#now()} WHERE id = ${row.id}`;
					told++;
				} catch (error) {
					if (controller.signal.aborted) break;
					const attempts = row.notify_attempts + 1;
					this.#logger.warn(
						{ push: String(row.id), code: errorCode(error), attempts },
						"a LINE push result could not be handed to the subscriber",
					);
					const giveUp = attempts >= MAX_NOTIFY_ATTEMPTS;
					await this.#sql`UPDATE line_outbox
						SET notify_attempts = ${attempts},
							notify_after = ${new Date(this.#now().getTime() + backoffMs(attempts, this.options, this.#random))},
							notified_at = ${giveUp ? this.#now() : null}
						WHERE id = ${row.id}`;
				}
			}
		} finally {
			this.#aborts.delete(controller);
		}
		return told;
	}

	/** Starts the loop: leases are recovered first, then pushes are sent as they come due. */
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
				await this.notify();
			} catch (error) {
				this.#logger.error(
					{ code: errorCode(error) },
					"the LINE outbox worker could not read the outbox",
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

	async #fill(): Promise<void> {
		while (this.#running && this.#inflight.size < this.options.concurrency) {
			const row = await this.#claim();
			if (!row) break;
			const id = String(row.id);
			this.#active.add(id);
			const task: Promise<void> = this.#handle(row)
				.catch((error) =>
					this.#logger.error(
						{ code: errorCode(error) },
						"a LINE push could not be recorded",
					),
				)
				.finally(() => {
					this.#active.delete(id);
					this.#inflight.delete(task);
					this.kick();
				});
			this.#inflight.add(task);
		}
	}

	/** Stops claiming, aborts the pushes in hand (they go back as they were) and waits for them. */
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
	return new LineError("worker_stopped", "line: the outbox worker is stopping");
}
