import type { LineApi, RequestOptions } from "./api.ts";
import { LineError } from "./errors.ts";
import { parseSourceKey } from "./events.ts";

export interface QuotaOptions {
	/**
	 * The most messages this month a push may bring consumption to, however much of the plan's quota is
	 * left; the gate keeps to the lower of the two. Unset: the plan's quota alone.
	 */
	monthlyCap?: number;
	/**
	 * How long, in milliseconds, a push that was sent (or may have been) stays reserved when LINE's
	 * consumption has not grown by its recipients by then. LINE calls its figure approximate and may
	 * be slow to count; this bounds how long the gate waits for it. Default 10 minutes.
	 */
	holdMs?: number;
}

/** How long a sent push stays reserved if LINE's consumption never shows it. */
export const QUOTA_HOLD_MS = 10 * 60_000;

/** How long a reading of LINE's quota, consumption and a chat's member count is trusted. */
export const QUOTA_CACHE_MS = 60_000;

/** A push the gate let through, until it is settled. */
export interface Reservation {
	/** The recipients it counts for. */
	readonly recipients: number;
}

export type Reserved =
	| { ok: true; reservation: Reservation }
	| {
			ok: false;
			/** The reading the push was refused on, for the log: counts only. */
			used: number;
			reserved: number;
			recipients: number;
			cap: number;
	  };

interface Reading {
	/** The plan's monthly limit, undefined when it has none. */
	limit: number | undefined;
	used: number;
	/** When the reading began, in milliseconds. */
	at: number;
}

export interface QuotaGateDeps {
	api: LineApi;
	now: () => Date;
	options?: QuotaOptions;
	cacheMs?: number;
}

/**
 * Keeps pushes inside the month's budget. A push is let through only while LINE's consumption, what
 * this process has reserved for pushes it has sent or is sending, and the push's own recipients (one,
 * or the member count of a group or room) stay within the lower of the plan's quota and `monthlyCap`.
 *
 * LINE's quota and consumption are read at most once a minute. LINE calls the figure approximate,
 * so a reservation for a push that went out (or may have: a timeout or a 5xx) stays counted until
 * the consumption read has grown by its recipients since the push was sent, or `holdMs` has passed;
 * one for a push that did not go out is dropped at once. Only this process's reservations are known: with several
 * processes, set `monthlyCap` below the quota by their share.
 */
export class QuotaGate {
	readonly #api: LineApi;
	readonly #now: () => Date;
	readonly #cap: number | undefined;
	readonly #cacheMs: number;
	readonly #holdMs: number;
	#reading: Reading | undefined;
	#inflight: Promise<Reading> | undefined;
	readonly #reservations = new Map<
		Reservation,
		{ settledAt: number | undefined; unseen: number }
	>();
	/** The consumption of the previous reading, to see how much it has grown. */
	#lastUsed: number | undefined;
	readonly #counts = new Map<string, { n: number; at: number }>();

	constructor(deps: QuotaGateDeps) {
		this.#api = deps.api;
		this.#now = deps.now;
		this.#cap = deps.options?.monthlyCap;
		this.#cacheMs = deps.cacheMs ?? QUOTA_CACHE_MS;
		this.#holdMs = deps.options?.holdMs ?? QUOTA_HOLD_MS;
	}

	/** How many people a push to the chat reaches; a count is trusted for a minute. */
	async recipients(
		sourceKey: string,
		call: Pick<RequestOptions, "signal" | "timeoutMs"> = {},
	): Promise<number> {
		const source = parseSourceKey(sourceKey);
		if (!source)
			throw new LineError("bad_source_key", "line: not a source key");
		if (source.kind === "user") return 1;
		const now = this.#now().getTime();
		const held = this.#counts.get(sourceKey);
		if (held && now - held.at < this.#cacheMs) return held.n;
		const n = await this.#api.recipients(source.kind, source.id, call);
		this.#counts.set(sourceKey, { n, at: now });
		return n;
	}

	/**
	 * The month as the gate last read it, refreshed when older than a minute: the plan's limit
	 * (undefined without one) and the consumption, which is 0 when there is neither a limit nor a cap
	 * of our own, because nothing is read then.
	 */
	async standing(): Promise<{ limit: number | undefined; used: number }> {
		const { limit, used } = await this.#read();
		return { limit, used };
	}

	/** The `monthlyCap` of the options, if one is set. */
	get cap(): number | undefined {
		return this.#cap;
	}

	async #read(): Promise<Reading> {
		const now = this.#now().getTime();
		if (this.#reading && now - this.#reading.at < this.#cacheMs)
			return this.#reading;
		this.#inflight ??= (async () => {
			const at = this.#now().getTime();
			const limit = await this.#api.messageQuota();
			// With no limit and no cap of our own there is nothing to compare with.
			const used =
				limit === undefined && this.#cap === undefined
					? 0
					: await this.#api.messageConsumption();
			const reading = { limit, used, at };
			this.#reading = reading;
			// What consumption has grown by since the last reading is what LINE has counted of the pushes
			// sent before this reading began, oldest first; a push is let go once all of it is counted.
			let grown =
				this.#lastUsed === undefined ? 0 : Math.max(0, used - this.#lastUsed);
			this.#lastUsed = used;
			const counted = [...this.#reservations]
				.filter(
					([, state]) => state.settledAt !== undefined && state.settledAt <= at,
				)
				.sort(([, a], [, b]) => (a.settledAt ?? 0) - (b.settledAt ?? 0));
			for (const [reservation, state] of counted) {
				const take = Math.min(grown, state.unseen);
				grown -= take;
				state.unseen -= take;
				if (state.unseen <= 0) this.#reservations.delete(reservation);
			}
			return reading;
		})().finally(() => {
			this.#inflight = undefined;
		});
		return this.#inflight;
	}

	/**
	 * Lets a push of `recipients` through or refuses it. Rejects when LINE's quota cannot be read, so a
	 * caller waits instead of sending without knowing.
	 */
	async reserve(recipients: number): Promise<Reserved> {
		const reading = await this.#read();
		this.#expire();
		const caps = [reading.limit, this.#cap].filter(
			(cap): cap is number => cap !== undefined,
		);
		const cap = caps.length > 0 ? Math.min(...caps) : Number.POSITIVE_INFINITY;
		const reserved = this.reserved();
		if (reading.used + reserved + recipients > cap)
			return { ok: false, used: reading.used, reserved, recipients, cap };
		const reservation: Reservation = { recipients };
		this.#reservations.set(reservation, {
			settledAt: undefined,
			unseen: recipients,
		});
		return { ok: true, reservation };
	}

	/**
	 * Ends a reservation: `sent` (also for a push whose outcome is not known) keeps it counted until
	 * LINE's consumption has grown by its recipients or `holdMs` has passed, otherwise it is dropped
	 * now.
	 */
	settle(reservation: Reservation, sent: boolean): void {
		const state = this.#reservations.get(reservation);
		if (!state) return;
		if (sent) state.settledAt = this.#now().getTime();
		else this.#reservations.delete(reservation);
	}

	/** Lets go of pushes that have been reserved for `holdMs` since they were sent. */
	#expire(): void {
		const now = this.#now().getTime();
		for (const [reservation, state] of this.#reservations)
			if (
				state.settledAt !== undefined &&
				now - state.settledAt >= this.#holdMs
			)
				this.#reservations.delete(reservation);
	}

	/** Messages reserved and not yet in LINE's consumption, for tests and status. */
	reserved(): number {
		this.#expire();
		let total = 0;
		for (const state of this.#reservations.values()) total += state.unseen;
		return total;
	}
}
