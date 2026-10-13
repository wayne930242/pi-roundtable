import type { SQL } from "bun";
import type { Logger } from "pi-roundtable";
import { errorCode } from "./errors.ts";

const DAY_MS = 24 * 60 * 60_000;

export interface RetentionOptions {
	/**
	 * How long events are kept after they are done, skipped or dead, and how long one that never got
	 * handled (no subscriber was attached) waits before it is dropped with its payload; default 7 days.
	 */
	inboxMs: number;
	/** How long a message's metadata and tokens, its references and its tombstone are kept; default 7 days. */
	messagesMs: number;
	/**
	 * How long finished pushes (and a push that never got sent), and the record of a join notice, are
	 * kept; default 7 days. A push loses its message objects when it finishes, long before this.
	 */
	outboxMs: number;
	/**
	 * How long a ref of an unsent message may wait before the sweep hands it back to the subscriber as
	 * `unsent`; default 15 minutes. Such a ref is a stray: a handler that outlived its lease kept it
	 * after the unsend had run.
	 */
	strayMs: number;
	/** How often the sweeper runs; default 1 hour. At most 2_147_483_647. */
	intervalMs: number;
}

export const RETENTION_DEFAULTS: RetentionOptions = {
	inboxMs: 7 * DAY_MS,
	messagesMs: 7 * DAY_MS,
	outboxMs: 7 * DAY_MS,
	strayMs: 15 * 60_000,
	intervalMs: 60 * 60_000,
};

/** The longest delay a timer holds. */
const MAX_TIMER_MS = 2_147_483_647;

/** Refuses a mistake in the retention options, naming the field. */
export function checkRetention(options: Partial<RetentionOptions>): void {
	for (const [key, value] of Object.entries(options)) {
		if (!(key in RETENTION_DEFAULTS))
			throw new Error(`line: retention.${key} is not a retention option`);
		if (!Number.isInteger(value) || (value as number) < 1)
			throw new Error(
				`line: retention.${key} must be a positive whole number of milliseconds; got ${String(value)}`,
			);
	}
	if ((options.intervalMs ?? 0) > MAX_TIMER_MS)
		throw new Error(
			`line: retention.intervalMs must be at most ${MAX_TIMER_MS} milliseconds (about 24 days); got ${String(options.intervalMs)}`,
		);
}

/**
 * One table the sweeper trims. `window` names the retention option that says how old a row may get;
 * `run` deletes the rows older than `cutoff` and answers how many went.
 */
interface RetentionTask {
	name: string;
	window: "inboxMs" | "messagesMs" | "outboxMs";
	run(sql: SQL, cutoff: Date): Promise<number>;
}

/** Deletes with `DELETE ... RETURNING` and counts the rows that went. */
async function count(
	rows: PromiseLike<{ n: number | string }[]>,
): Promise<number> {
	return Number((await rows)[0]?.n ?? 0);
}

const TASKS: readonly RetentionTask[] = [
	{
		name: "inbox",
		window: "inboxMs",
		run: (sql, cutoff) =>
			count(sql`WITH gone AS (
				DELETE FROM line_inbox
				WHERE status IN ('done', 'skipped', 'dead') AND completed_at < ${cutoff}
				RETURNING 1) SELECT count(*)::int AS n FROM gone`),
	},
	{
		// Waiting events keep their payload; with no subscriber they would keep it for ever.
		name: "inbox_waiting",
		window: "inboxMs",
		run: (sql, cutoff) =>
			count(sql`WITH gone AS (
				DELETE FROM line_inbox WHERE status = 'pending' AND created_at < ${cutoff}
				RETURNING 1) SELECT count(*)::int AS n FROM gone`),
	},
	{
		name: "messages",
		window: "messagesMs",
		run: (sql, cutoff) =>
			count(sql`WITH gone AS (
				DELETE FROM line_messages WHERE created_at < ${cutoff}
				RETURNING 1) SELECT count(*)::int AS n FROM gone`),
	},
	{
		name: "refs",
		window: "messagesMs",
		run: (sql, cutoff) =>
			count(sql`WITH gone AS (
				DELETE FROM line_message_refs WHERE created_at < ${cutoff}
				RETURNING 1) SELECT count(*)::int AS n FROM gone`),
	},
	{
		name: "tombstones",
		window: "messagesMs",
		run: (sql, cutoff) =>
			count(sql`WITH gone AS (
				DELETE FROM line_tombstones WHERE created_at < ${cutoff}
				RETURNING 1) SELECT count(*)::int AS n FROM gone`),
	},
	{
		// A push that finished, and one that never did (a chat that stopped being allowed, say).
		name: "outbox",
		window: "outboxMs",
		run: (sql, cutoff) =>
			count(sql`WITH gone AS (
				DELETE FROM line_outbox
				WHERE (status IN ('sent', 'dead', 'refused') AND completed_at < ${cutoff})
					OR (status IN ('queued', 'sending') AND created_at < ${cutoff})
				RETURNING 1) SELECT count(*)::int AS n FROM gone`),
	},
	{
		name: "notices",
		window: "outboxMs",
		run: (sql, cutoff) =>
			count(sql`WITH gone AS (
				DELETE FROM line_notices WHERE created_at < ${cutoff}
				RETURNING 1) SELECT count(*)::int AS n FROM gone`),
	},
];

export interface RetentionDeps {
	sql: SQL;
	logger: Logger;
	now: () => Date;
	options?: Partial<RetentionOptions>;
	/**
	 * Hands the refs of unsent messages that nobody took back to the subscriber, those stored before
	 * `before`; answers how many messages it handed back. Runs first in every sweep, so a stray is
	 * taken back before retention would forget it.
	 */
	strays?: (before: Date) => Promise<number>;
}

/**
 * Trims the package's tables once an hour: events that are finished or never handled, and the
 * metadata, references and tombstones of messages. It logs counts only. A table that cannot be
 * trimmed is logged by its code and the others go on.
 */
export class RetentionSweeper {
	readonly #sql: SQL;
	readonly #logger: Logger;
	readonly #now: () => Date;
	readonly #strays: ((before: Date) => Promise<number>) | undefined;
	readonly options: RetentionOptions;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#running = false;
	#sweeping: Promise<Record<string, number>> | undefined;

	constructor(deps: RetentionDeps) {
		this.#sql = deps.sql;
		this.#logger = deps.logger;
		this.#now = deps.now;
		this.#strays = deps.strays;
		this.options = { ...RETENTION_DEFAULTS, ...deps.options };
	}

	/** `"retention"` while a sweep runs, for the shutdown drain. */
	busy(): string[] {
		return this.#sweeping ? ["retention"] : [];
	}

	/** One sweep now; rows older than their window are gone. Returns the count deleted from each table. */
	sweepOnce(): Promise<Record<string, number>> {
		this.#sweeping ??= this.#sweep().finally(() => {
			this.#sweeping = undefined;
		});
		return this.#sweeping;
	}

	async #sweep(): Promise<Record<string, number>> {
		const counts: Record<string, number> = {};
		const now = this.#now().getTime();
		if (this.#strays) {
			try {
				counts.strays = await this.#strays(
					new Date(now - this.options.strayMs),
				);
			} catch (error) {
				counts.strays = 0;
				this.#logger.warn(
					{ table: "strays", code: errorCode(error) },
					"a LINE retention sweep could not hand back stray refs",
				);
			}
		}
		for (const task of TASKS) {
			const cutoff = new Date(now - this.options[task.window]);
			try {
				counts[task.name] = await task.run(this.#sql, cutoff);
			} catch (error) {
				counts[task.name] = 0;
				this.#logger.warn(
					{ table: task.name, code: errorCode(error) },
					"a LINE retention sweep could not trim a table",
				);
			}
		}
		if (Object.values(counts).some((n) => n > 0))
			this.#logger.info(counts, "LINE retention removed rows");
		return counts;
	}

	/** Sweeps now, then every `intervalMs`. */
	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#schedule(0);
	}

	#schedule(delayMs: number): void {
		this.#timer = setTimeout(() => {
			void this.sweepOnce().finally(() => {
				if (this.#running) this.#schedule(this.options.intervalMs);
			});
		}, delayMs);
		this.#timer.unref?.();
	}

	/** Stops the schedule and waits for a sweep in progress. */
	async stop(): Promise<void> {
		this.#running = false;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
		await this.#sweeping?.catch(() => undefined);
	}
}
