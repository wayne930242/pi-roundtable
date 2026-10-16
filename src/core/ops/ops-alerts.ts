import type { Logger } from "../log.ts";
import { AlertThrottle } from "./alert-throttle.ts";

const DEFAULT_WINDOW_MS = 60 * 60_000;
const DEFAULT_KIND_CAP = 8;

export interface OpsAlertsOptions {
	/**
	 * Posts one alert's text where the people who run the host read it. Resolves true when it was
	 * posted and false when the sink chose not to (it logs why itself); a throw is a failed post.
	 * Either way the key and the slot are given back, so the next raise tries again. Absent: alerts are
	 * only recorded and logged, the key still held so the log has one line per window.
	 */
	sink?: (text: string) => Promise<boolean>;
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
}

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
			if (await sink(text)) return true;
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
