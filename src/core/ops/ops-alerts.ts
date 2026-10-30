import type { Logger } from "../log.ts";
import { AlertThrottle } from "./alert-throttle.ts";

const DEFAULT_WINDOW_MS = 60 * 60_000;
const DEFAULT_KIND_CAP = 8;

/** How serious a raised alert says it is; only the sink reads it, to choose a picture or a route. */
export type OpsSeverity = "info" | "warning" | "critical";

/** What the sink is told about an alert besides its text. */
export interface OpsAlert {
	/** The key's word before the first colon. */
	kind: string;
	/** The key the alert was raised under; `OpsAlerts.resolve` takes it. */
	key: string;
	/** The short code given to `raise`, when there was one. */
	code?: string;
	/** Set when the alert is news, not a fault. */
	info?: true;
	/** The severity given to `raise`, when there was one. */
	severity?: OpsSeverity;
}

/** What the sink is told when an alert's fault is over. */
export interface OpsResolution {
	kind: string;
	key: string;
}

/**
 * Posts one alert's text where the people who run the host read it. Resolves true when it was
 * posted and false when the sink chose not to (it logs why itself); a throw is a failed post. A sink
 * written to take only the text still fits: the second argument is simply not read.
 */
export interface OpsSink {
	(text: string, alert: OpsAlert): Promise<boolean>;
	/**
	 * Called when `OpsAlerts.resolve` ends a fault whose alert was posted, so the sink can mark that
	 * alert as recovered, such as editing its message. A throw is logged by its name and never
	 * reaches the caller of `resolve`.
	 */
	resolved?(event: OpsResolution): Promise<void> | void;
}

export interface OpsAlertsOptions {
	/**
	 * Where alerts are posted. Either way a post ends, the key and the slot are given back when it
	 * did not succeed, so the next raise tries again. Absent: alerts are only recorded and logged,
	 * the key still held so the log has one line per window.
	 */
	sink?: OpsSink;
	logger: Logger;
	/** What `faults()` calls each kind; a kind not listed is called by itself. */
	kinds?: Readonly<Record<string, string>>;
	/** Default one hour. */
	windowMs?: number;
	/** The most alerts of one kind posted inside a window, whatever their keys; default 8. */
	kindCap?: number;
	now?: () => number;
}

export interface OpsRaiseOptions {
	/** A short code (letters, digits, `_`, `:`) shown in `faults()`; never a name or anyone's words. */
	code?: string;
	/** News, not a fault: posted at most once per key, not counted against the kind's cap, not listed. */
	info?: boolean;
	/** Passed to the sink with the text; nothing in `OpsAlerts` reads it. */
	severity?: OpsSeverity;
}

/** The last fault of one kind since the start, and how often it came. */
export interface OpsAlertKind {
	kind: string;
	name: string;
	at: number;
	code: string | undefined;
	/** Raised since the start, posted or not. */
	raised: number;
	/** Of those, held back because the key or the kind had been raised inside the window. */
	suppressed: number;
	/**
	 * When `resolve` ended the kind's last open alert, and no fault of the kind has been raised
	 * since; absent while the kind has an alert posted and not resolved, or none was ever
	 * resolved.
	 */
	clearedAt?: number;
}

/** The most posted alerts `resolve` remembers; the oldest is forgotten past it. */
const POSTED_CAP = 1_000;

/** The kind of an alert is the word before the first colon of its key. */
function kindOf(key: string): string {
	const colon = key.indexOf(":");
	return colon === -1 ? key : key.slice(0, colon);
}

/**
 * Short alerts for the people who run a host. Every alert has a key; its kind is the key's word
 * before the first colon. A key is posted at most once a window and a kind at most `kindCap` times,
 * so a fault that touches everything cannot flood the sink; what is held back is counted, never
 * summed up in a post. An alert is posted when it is raised, not queued. A failed post is logged by
 * the error's name and never thrown.
 */
export class OpsAlerts {
	readonly #options: OpsAlertsOptions;
	readonly #throttle: AlertThrottle;
	readonly #kinds = new Map<string, OpsAlertKind>();
	/** The faults posted and not resolved, oldest first, by key. */
	readonly #posted = new Map<string, string>();

	constructor(options: OpsAlertsOptions) {
		this.#options = options;
		this.#throttle = new AlertThrottle({
			windowMs: options.windowMs ?? DEFAULT_WINDOW_MS,
			groupCap: options.kindCap ?? DEFAULT_KIND_CAP,
			now: options.now ?? Date.now,
		});
	}

	/** Whether alerts reach a sink. */
	get posts(): boolean {
		return this.#options.sink !== undefined;
	}

	/** The last fault of each kind, newest first; memory only. */
	faults(): OpsAlertKind[] {
		return [...this.#kinds.values()].sort((a, b) => b.at - a.at);
	}

	/**
	 * Says the fault of a key is over: gives the key back, so a new fault under it posts again, calls
	 * the sink's `resolved` when the key's alert was posted, and marks the kind in `faults()` as
	 * cleared once none of its alerts is open. Resolving a key that was not posted, or that is
	 * already resolved, does nothing, and so does resolving one whose post has not finished.
	 * Never throws; whether it ended an open alert.
	 */
	async resolve(key: string): Promise<boolean> {
		const { sink, logger } = this.#options;
		const kind = this.#posted.get(key);
		if (kind === undefined) return false;
		this.#posted.delete(key);
		this.#throttle.release(key);
		const entry = this.#kinds.get(kind);
		if (entry && ![...this.#posted.values()].includes(kind))
			entry.clearedAt = (this.#options.now ?? Date.now)();
		try {
			await sink?.resolved?.({ kind, key });
		} catch (error) {
			logger.warn(
				{ error: error instanceof Error ? error.name : "unknown" },
				"an ops alert's recovery could not be posted",
			);
		}
		return true;
	}

	/** Posts the alert unless its key or its kind is held inside the window; whether it was posted. */
	async raise(
		key: string,
		text: string,
		options: OpsRaiseOptions = {},
	): Promise<boolean> {
		const { sink, logger } = this.#options;
		const kind = kindOf(key);
		const info = options.info === true;
		const admission = this.#throttle.admit(key, kind, info);
		if (!info) this.#record(kind, options.code, admission !== "open");
		if (admission !== "open") return false;
		// Taken before the post, so two alerts raised together for one key post once.
		this.#throttle.hold(key);
		if (sink === undefined) {
			// Nowhere to post: the key stays held so that the log has one line per window, not one per event.
			logger.warn(
				{ kind, ...(options.code ? { code: options.code } : {}) },
				"an ops alert was raised and there is no sink to post it to",
			);
			return false;
		}
		if (!info) this.#throttle.slot(kind);
		const undo = () => this.#throttle.release(key, info ? undefined : kind);
		try {
			const sent = await sink(text, {
				kind,
				key,
				...(options.code ? { code: options.code } : {}),
				...(info ? { info: true as const } : {}),
				...(options.severity ? { severity: options.severity } : {}),
			});
			if (sent) {
				if (!info) this.#open(key, kind);
				return true;
			}
			undo();
			return false;
		} catch (error) {
			// Asked again by the next event instead of staying silent for the whole window.
			undo();
			logger.warn(
				{ error: error instanceof Error ? error.name : "unknown" },
				"an ops alert could not be posted",
			);
			return false;
		}
	}

	#open(key: string, kind: string): void {
		this.#posted.delete(key);
		this.#posted.set(key, kind);
		for (const old of this.#posted.keys()) {
			if (this.#posted.size <= POSTED_CAP) break;
			this.#posted.delete(old);
		}
	}

	#record(kind: string, code: string | undefined, suppressed: boolean): void {
		const before = this.#kinds.get(kind);
		const { kinds, now } = this.#options;
		this.#kinds.set(kind, {
			kind,
			name: kinds && Object.hasOwn(kinds, kind) ? (kinds[kind] ?? kind) : kind,
			at: (now ?? Date.now)(),
			code,
			raised: (before?.raised ?? 0) + 1,
			suppressed: (before?.suppressed ?? 0) + (suppressed ? 1 : 0),
		});
	}
}
