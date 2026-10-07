import { AsyncLocalStorage } from "node:async_hooks";
import type { ScheduledOutcome } from "../contract/channels.ts";
import type { LogEntry, Logger } from "../log.ts";
import type { ChannelKey } from "../sessions.ts";

/** Errors that are expected and never reported, matched against the message and the error's. */
export const IGNORED_ERRORS: readonly RegExp[] = [];

const HOUR_MS = 3_600_000;
/** Reports, summaries included, per rolling hour. */
const REPORTS_PER_HOUR = 5;
/** Errors kept from before the agent server is ready; older ones are dropped and counted. */
const EARLY_BUFFER = 20;
const REPORT_LIMIT = 1500;
const FIELD_LIMIT = 200;
const STACK_FRAMES = 8;
/** pino's own keys, and the ones the report shows apart from the context. */
const OWN_KEYS = new Set(["level", "time", "pid", "hostname", "msg", "err"]);
const HEAD_KEYS = ["app", "plugin", "module"];
const APP_FRAME = /((?:src|shared|worker)\/[^\s():]+\.ts):(\d+)/;

/** Who investigates the errors: an agent, in its channel, or the claim of one conversation. */
export type ErrorReportDestination =
	| { agent: string }
	| { conversation: ChannelKey };

/** How the reports are delivered, known once the surfaces, and for an agent the team, are up. */
export interface ErrorReportDelivery {
	/**
	 * The agent's channel while it is active; undefined for an archived or unknown agent. Asked
	 * only for an agent's reports.
	 */
	channelOf?(agent: string): ChannelKey | undefined;
	/** The visible message in the channel. */
	post(channel: ChannelKey, text: string): Promise<void>;
	/** The report turn; resolves when it has run. */
	turn(channel: ChannelKey, text: string): Promise<ScheduledOutcome>;
	logger: Logger;
}

export interface ErrorReporterOptions {
	/** Who investigates the errors. */
	destination: ErrorReportDestination;
	/** The name the reports give the process, such as "Roundtable". */
	app: string;
	ignored?: readonly RegExp[];
	/** Replaceable in tests. */
	now?: () => number;
	/** Replaceable in tests. */
	setTimer?: (run: () => void, ms: number) => void;
}

/**
 * The process's own `error` and `fatal` log entries, each reported to the ops agent or the ops
 * conversation as a visible message and a report turn in its channel. The same error goes at most once an hour, and at
 * most five reports an hour overall; the rest are counted and summed up in one report when the
 * hour allows. Errors from the reporting itself are only logged; errors logged elsewhere while
 * an error-report turn runs are counted and summed up once it ends.
 */
export class ErrorReporter {
	readonly destination: ErrorReportDestination;
	readonly #app: string;
	readonly #ignored: readonly RegExp[];
	readonly #now: () => number;
	readonly #setTimer: (run: () => void, ms: number) => void;
	/** Set inside the reporting path: posting, the turn, and the reporter's own logging. */
	readonly #reporting = new AsyncLocalStorage<true>();
	#delivery: ErrorReportDelivery | undefined;
	#early: LogEntry[] = [];
	#earlyDropped = 0;
	/** Report turns started and not yet finished. */
	#turns = 0;
	#sent: number[] = [];
	readonly #lastSent = new Map<string, number>();
	readonly #suppressed = new Map<string, number>();
	#summaryDue = false;

	constructor(options: ErrorReporterOptions) {
		this.destination = options.destination;
		this.#app = options.app;
		this.#ignored = options.ignored ?? IGNORED_ERRORS;
		this.#now = options.now ?? Date.now;
		this.#setTimer =
			options.setTimer ??
			((run, ms) => {
				setTimeout(run, ms).unref();
			});
	}

	/** Takes one log entry; the logger calls it for every `error` and `fatal` line. */
	record(entry: LogEntry): void {
		if (typeof entry.level !== "number" || entry.level < 50) return;
		if (this.#reporting.getStore()) return;
		if (this.#isIgnored(entry)) return;
		if (this.#turns > 0) {
			// The ops agent is already looking at an error; these wait for the summary after its turn.
			const key = fingerprint(entry);
			this.#suppressed.set(key, (this.#suppressed.get(key) ?? 0) + 1);
			return;
		}
		if (!this.#delivery) {
			this.#early.push(entry);
			if (this.#early.length > EARLY_BUFFER) {
				this.#early.shift();
				this.#earlyDropped += 1;
			}
			return;
		}
		this.#consider(entry);
	}

	/** Starts reporting, the errors kept from startup first; later calls do nothing. */
	connect(delivery: ErrorReportDelivery): void {
		if (this.#delivery) return;
		this.#delivery = delivery;
		const early = this.#early;
		this.#early = [];
		if (this.#earlyDropped > 0)
			this.#reporting.run(true, () =>
				delivery.logger.warn(
					{ dropped: this.#earlyDropped },
					"early errors dropped before reporting started",
				),
			);
		this.#earlyDropped = 0;
		for (const entry of early) this.#consider(entry);
	}

	#isIgnored(entry: LogEntry): boolean {
		const text = `${String(entry.msg ?? "")}\n${errorOf(entry)?.message ?? ""}`;
		return this.#ignored.some((pattern) => pattern.test(text));
	}

	#consider(entry: LogEntry): void {
		const now = this.#now();
		const key = fingerprint(entry);
		const last = this.#lastSent.get(key);
		if (last !== undefined && now - last < HOUR_MS) return;
		if (!this.#hasRoom(now)) {
			this.#suppressed.set(key, (this.#suppressed.get(key) ?? 0) + 1);
			this.#scheduleSummary(now);
			return;
		}
		this.#lastSent.set(key, now);
		this.#sent.push(now);
		void this.#deliver(reportText(entry, this.#app));
	}

	#hasRoom(now: number): boolean {
		this.#sent = this.#sent.filter((at) => now - at < HOUR_MS);
		return this.#sent.length < REPORTS_PER_HOUR;
	}

	#scheduleSummary(now: number): void {
		if (this.#summaryDue) return;
		this.#summaryDue = true;
		const oldest = this.#sent[0] ?? now;
		this.#setTimer(() => this.#summarize(), oldest + HOUR_MS - now);
	}

	#summarize(): void {
		this.#summaryDue = false;
		const now = this.#now();
		if (this.#suppressed.size === 0) return;
		if (!this.#hasRoom(now)) {
			this.#scheduleSummary(now);
			return;
		}
		const counts = [...this.#suppressed];
		this.#suppressed.clear();
		const total = counts.reduce((sum, [, n]) => sum + n, 0);
		for (const [key] of counts) this.#lastSent.set(key, now);
		this.#sent.push(now);
		const list = counts
			.map(([key, n]) => (n > 1 ? `${key} (×${n})` : key))
			.join("; ");
		void this.#deliver(
			trim(
				`${this.#app} error reports: ${total} more errors suppressed: ${list}`,
			),
		);
	}

	#deliver(text: string): Promise<void> {
		const delivery = this.#delivery;
		if (!delivery) return Promise.resolve();
		return this.#reporting.run(true, async () => {
			const { destination } = this;
			const channel =
				"conversation" in destination
					? destination.conversation
					: delivery.channelOf?.(destination.agent);
			if (!channel) return;
			try {
				await delivery.post(channel, text);
				// pi-lens-ignore: missing-error-propagation — a report never throws back into the logger
			} catch (error) {
				delivery.logger.error(
					{ channel, err: error },
					"error report not posted",
				);
			}
			this.#turns += 1;
			try {
				const outcome = await delivery.turn(channel, text);
				if (outcome.status !== "ran")
					delivery.logger.warn(
						{ channel, outcome },
						"error report not answered",
					);
				// pi-lens-ignore: missing-error-propagation — a report never throws back into the logger
			} catch (error) {
				delivery.logger.error(
					{ channel, err: error },
					"error report turn failed",
				);
			} finally {
				this.#turns -= 1;
				if (this.#turns === 0 && this.#suppressed.size > 0) this.#summarize();
			}
		});
	}
}

function errorOf(
	entry: LogEntry,
): { type?: string; message?: string; stack?: string } | undefined {
	const err = entry.err;
	return err && typeof err === "object"
		? (err as Record<string, string>)
		: undefined;
}

/**
 * What makes two errors the same: the message and where it was raised, the first frame of
 * the process's own code, or else the names of the logged fields. Never times or ids.
 */
export function fingerprint(entry: LogEntry): string {
	const frame = errorOf(entry)?.stack?.match(APP_FRAME);
	const where = frame
		? `${frame[1]}:${frame[2]}`
		: // pi-lens-ignore: no-sort-without-comparator — field names, in string order
			contextKeys(entry).sort().join(",");
	const msg = String(entry.msg ?? "");
	return where ? `${msg} @ ${where}` : msg;
}

function contextKeys(entry: LogEntry): string[] {
	return Object.keys(entry).filter(
		(key) => !OWN_KEYS.has(key) && !HEAD_KEYS.includes(key),
	);
}

/** The report: the message, app and module, the logged fields, and a trimmed stack. */
export function reportText(entry: LogEntry, app: string): string {
	const lines = [`${app} logged an error: ${String(entry.msg ?? "")}`];
	const head = HEAD_KEYS.flatMap((key) =>
		entry[key] === undefined ? [] : [`${key}: ${String(entry[key])}`],
	);
	if (head.length > 0) lines.push(head.join(" · "));
	for (const key of contextKeys(entry))
		lines.push(`${key}: ${short(entry[key])}`);
	const err = errorOf(entry);
	if (err?.stack) {
		const [first, ...frames] = err.stack.split("\n");
		lines.push(
			first ?? "",
			...frames.slice(0, STACK_FRAMES).map((frame) => frame.trimEnd()),
		);
	} else if (err?.message) lines.push(`${err.type ?? "Error"}: ${err.message}`);
	return trim(lines.join("\n"));
}

function short(value: unknown): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length > FIELD_LIMIT ? `${text.slice(0, FIELD_LIMIT)}…` : text;
}

function trim(text: string): string {
	return text.length > REPORT_LIMIT
		? `${text.slice(0, REPORT_LIMIT - 1)}…`
		: text;
}
