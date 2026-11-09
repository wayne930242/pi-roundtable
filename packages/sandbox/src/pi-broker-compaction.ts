import type { ChannelKey } from "pi-roundtable";
import { HARD_COMPACT_TOKENS, scrubDiagnostic } from "pi-roundtable/kit";
import {
	PI_COMPACT_LIMITS,
	type PiBrokerOptions,
	type PiHostContext,
} from "./pi-broker-options.ts";
import { abortableCompact, errorText } from "./pi-broker-upstream.ts";
import {
	type PiCompactionReport,
	type PiCompactResponse,
	validateCompactionReport,
	validateCompactRequest,
} from "./pi-protocol.ts";
import { boundedText, isRecord } from "./protocol.ts";

/** The compaction routes of the broker: a host compaction for the worker, and the worker's reports. */
export class BrokerCompaction {
	readonly #options: PiBrokerOptions;

	constructor(options: PiBrokerOptions) {
		this.#options = options;
	}

	/** Settles when the running compactor really ends, even after its request fell back. */
	#compacting: Promise<unknown> | undefined;
	readonly #compactionUse = new WeakMap<
		object,
		{ compacts: number; reports: number }
	>();
	/** The worker's compactions, only inside an admitted turn: a host compaction, or a report to log. */
	async handle(
		request: Request,
		path: string,
		turn: { context: PiHostContext } | undefined,
	): Promise<Response> {
		if (request.method !== "POST")
			return new Response("Not found", { status: 404 });
		if (!turn || turn.context.signal.aborted)
			return new Response("Turn ended", { status: 410 });
		const { channel } = turn.context;
		const logger = this.#options.logger;
		const use = this.#compactionUse.get(turn) ?? { compacts: 0, reports: 0 };
		this.#compactionUse.set(turn, use);
		if (path === "/compaction/report") {
			// A turn compacts a few times at most; more reports only fill the host's log.
			if (++use.reports > PI_COMPACT_LIMITS.reportsPerTurn)
				return new Response("Report budget exhausted", { status: 429 });
			try {
				const report: unknown = JSON.parse(
					await boundedText(request.body, 64 * 1024, turn.context.signal),
				);
				validateCompactionReport(report);
				this.#logReport(channel, report);
				return new Response("Accepted");
			} catch {
				return new Response("Invalid report", { status: 400 });
			}
		}
		const compactor = this.#options.compaction;
		const fallback = (reason: string): Response => {
			logger?.warn(
				{ channel, engine: compactor?.engine, fallback: reason },
				"compaction falls back to Pi's summary",
			);
			return Response.json({
				ok: false,
				fallback: reason,
			} satisfies PiCompactResponse);
		};
		if (!compactor) return fallback("the host has no compactor");
		if (this.#compacting) return fallback("a compaction is already running");
		if (++use.compacts > PI_COMPACT_LIMITS.compactsPerTurn)
			return fallback(
				`the turn already asked for ${PI_COMPACT_LIMITS.compactsPerTurn} compactions`,
			);
		const maxBytes =
			compactor.maxRequestBytes ?? PI_COMPACT_LIMITS.requestBytes;
		if (Number(request.headers.get("content-length") ?? 0) > maxBytes)
			return fallback(`the request is over ${maxBytes} bytes`);
		// Pi's own summary must still fit after a compactor that runs out of time.
		const left =
			turn.context.deadline === undefined
				? Number.POSITIVE_INFINITY
				: turn.context.deadline - Date.now();
		const timeoutMs = Math.min(
			compactor.timeoutMs ?? PI_COMPACT_LIMITS.timeoutMs,
			Math.floor(left / 2),
		);
		if (timeoutMs < 1000)
			return fallback(
				"the turn has too little time left for the host compactor",
			);
		let running: Promise<unknown> = Promise.resolve();
		this.#compacting = running;
		const timeout = AbortSignal.timeout(timeoutMs);
		const signal = AbortSignal.any([
			turn.context.signal,
			request.signal,
			timeout,
		]);
		const started = Date.now();
		try {
			let compactRequest: unknown;
			try {
				compactRequest = JSON.parse(
					await boundedText(request.body, maxBytes, signal),
				);
				validateCompactRequest(compactRequest);
			} catch (error) {
				if (signal.aborted) throw error;
				return fallback(
					error instanceof Error && error.message === "body too large"
						? `the request is over ${maxBytes} bytes`
						: "the request is invalid",
				);
			}
			const compacting = compactor.compact(compactRequest, { channel, signal });
			running = compacting.catch(() => {});
			this.#compacting = running;
			const result = await abortableCompact(compacting, signal);
			if (!result) return fallback("the compactor declined");
			const details =
				result.details === undefined
					? { engine: compactor.engine }
					: isRecord(result.details)
						? { ...result.details, engine: compactor.engine }
						: undefined;
			if (
				!details ||
				typeof result.summary !== "string" ||
				result.summary.length === 0 ||
				result.firstKeptEntryId !== compactRequest.firstKeptEntryId ||
				!Number.isSafeInteger(result.tokensBefore) ||
				(result.estimatedTokensAfter !== undefined &&
					!Number.isSafeInteger(result.estimatedTokensAfter))
			)
				return fallback("the compactor's result is invalid");
			logger?.info(
				{
					channel,
					engine: compactor.engine,
					tokensBefore: result.tokensBefore,
					tokensAfter: result.estimatedTokensAfter,
					latencyMs: Date.now() - started,
				},
				"host compactor answered",
			);
			return Response.json({
				ok: true,
				compaction: {
					summary: result.summary,
					firstKeptEntryId: result.firstKeptEntryId,
					tokensBefore: result.tokensBefore,
					...(result.estimatedTokensAfter === undefined
						? {}
						: { estimatedTokensAfter: result.estimatedTokensAfter }),
					details,
				},
			} satisfies PiCompactResponse);
		} catch (error) {
			return fallback(
				timeout.aborted
					? `the compactor took over ${timeoutMs} ms`
					: signal.aborted
						? "the compaction was aborted"
						: `the compactor failed: ${scrubDiagnostic(errorText(error), 2000)}`,
			);
		} finally {
			// A compactor that ignored its signal still holds the slot until it really ends.
			void running.then(() => {
				if (this.#compacting === running) this.#compacting = undefined;
			});
		}
	}
	/** Logs a worker compaction the way the host logs its own sessions' compactions. */
	#logReport(channel: ChannelKey, report: PiCompactionReport): void {
		const logger = this.#options.logger;
		if (report.type === "bypass") {
			logger?.info(
				{
					channel,
					reason: report.reason,
					tokensBefore: report.tokensBefore,
					ceiling: HARD_COMPACT_TOKENS,
				},
				"compaction skips the extension for Pi's summary",
			);
			return;
		}
		const trigger = report.reason === "manual" ? "self" : report.reason;
		if (!report.engine) {
			logger?.warn(
				{ channel, trigger, aborted: report.aborted, error: report.error },
				"compaction failed",
			);
			return;
		}
		logger?.info(
			{
				channel,
				trigger,
				engine: report.engine,
				tokensBefore: report.tokensBefore,
				tokensAfter: report.tokensAfter,
				contextAfter: report.contextAfter,
				nextCompactionAt: report.nextCompactionAt,
			},
			"conversation compacted",
		);
	}
}
