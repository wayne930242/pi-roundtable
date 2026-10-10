/**
 * The worker session's compaction: the host's tiers, and the host's compactor reached over the broker.
 */
import type {
	AgentSession,
	AgentSessionEvent,
	ExtensionFactory,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	type CompactionHistory,
	CompactionTiers,
	compactionEngine,
	privateCompaction,
	summaryProjection,
} from "pi-roundtable/kit";
import type {
	PiCompactionReport,
	PiCompactMessage,
	PiCompactRequest,
	PiCompactResponse,
	PiWorkerConfig,
} from "../src/pi-protocol.ts";

type CompactionEnd = Extract<AgentSessionEvent, { type: "compaction_end" }>;
export type WorkerLog = (msg: string, fields?: Record<string, unknown>) => void;

export interface WorkerCompactionOptions {
	/** The session's entries, for the tiers' loop guard. */
	history: CompactionHistory;
	contextWindow(provider: string, id: string): number | undefined;
	/** What the host told the worker at startup; no `compaction` means no host compactor. */
	config: PiWorkerConfig;
	/** The broker's Unix socket. */
	socket: string;
	log: WorkerLog;
}

/** The request the host's compactor reads: Pi's preparation, with the messages it keeps. */
export function compactRequest(
	event: SessionBeforeCompactEvent,
): PiCompactRequest {
	const { preparation } = event;
	const start = event.branchEntries.findIndex(
		(entry) => entry.id === preparation.firstKeptEntryId,
	);
	const keptMessages =
		start < 0
			? []
			: event.branchEntries
					.slice(start)
					.flatMap((entry) =>
						entry.type === "message" ? [entry.message] : [],
					);
	privateCompaction(preparation, keptMessages);
	const projectedKept = summaryProjection(keptMessages, [
		...preparation.messagesToSummarize,
		...preparation.turnPrefixMessages,
		...keptMessages,
	]);
	const { read, written, edited } = preparation.fileOps;
	const modified = new Set([...written, ...edited]);
	return {
		reason: event.reason,
		tokensBefore: preparation.tokensBefore,
		firstKeptEntryId: preparation.firstKeptEntryId,
		isSplitTurn: preparation.isSplitTurn,
		messagesToSummarize: preparation.messagesToSummarize as PiCompactMessage[],
		turnPrefixMessages: preparation.turnPrefixMessages as PiCompactMessage[],
		keptMessages: projectedKept as PiCompactMessage[],
		...(preparation.previousSummary === undefined
			? {}
			: { previousSummary: preparation.previousSummary }),
		...(event.customInstructions === undefined
			? {}
			: { customInstructions: event.customInstructions }),
		readFiles: [...read].filter((path) => !modified.has(path)).sort(),
		modifiedFiles: [...modified].sort(),
	};
}

/**
 * Compacts as the host's own sessions do: large windows at the soft threshold through the host's
 * compactor, past the hard ceiling through Pi's summary, which reaches the model over the broker.
 */
export class WorkerCompaction {
	readonly #options: WorkerCompactionOptions;
	readonly #tiers: CompactionTiers;
	readonly #pending = new Set<Promise<void>>();

	constructor(options: WorkerCompactionOptions) {
		this.#options = options;
		this.#tiers = new CompactionTiers(
			options.history,
			options.contextWindow,
			options.config.compaction?.engine,
		);
	}

	/** Pi's settings, with each model's reserve set so it compacts at its tier. */
	settings(): SettingsManager {
		return this.#tiers.settings();
	}

	/** The host compactor's handler, held back by the tiers; none when the host has no compactor. */
	extensions(): { name: string; factory: ExtensionFactory }[] {
		if (!this.#options.config.compaction) return [];
		const handler: ExtensionFactory = (pi) => {
			pi.on("session_before_compact", (event) => this.#compact(event));
		};
		return [
			{
				name: "host-compaction",
				factory: this.#tiers.wrapCompactor(
					handler,
					(bypass) => {
						this.#options.log("compaction skips the host compactor", bypass);
						void this.#report({ type: "bypass", ...bypass });
					},
					(event) =>
						privateCompaction(
							event.preparation,
							event.branchEntries.flatMap((entry) =>
								entry.type === "message" ? [entry.message] : [],
							),
						),
				),
			},
		];
	}

	/** Logs a finished compaction and reports it to the host, which logs it for the channel. */
	async ended(event: CompactionEnd, session: AgentSession): Promise<void> {
		const { result } = event;
		const { model, settingsManager } = session;
		const report: PiCompactionReport = result
			? {
					type: "end",
					reason: event.reason,
					aborted: event.aborted,
					willRetry: event.willRetry,
					engine: compactionEngine(
						result.details,
						this.#options.config.compaction?.engine,
					),
					tokensBefore: result.tokensBefore,
					...(result.estimatedTokensAfter === undefined
						? {}
						: { tokensAfter: result.estimatedTokensAfter }),
					...this.#contextAfter(),
					...(model
						? {
								nextCompactionAt:
									model.contextWindow -
									settingsManager.getCompactionSettings(model).reserveTokens,
							}
						: {}),
				}
			: {
					type: "end",
					reason: event.reason,
					aborted: event.aborted,
					willRetry: event.willRetry,
					...(event.errorMessage === undefined
						? {}
						: { error: event.errorMessage.slice(0, 10_000) }),
				};
		const { type: _type, ...fields } = report;
		this.#options.log(
			result ? "conversation compacted" : "compaction failed",
			fields,
		);
		await this.#report(report);
	}

	/** The context the tiers measure after the compaction, system prompt and tools included. */
	#contextAfter(): { contextAfter?: number } {
		const latest = this.#tiers.latest();
		return latest ? { contextAfter: latest.contextTokens } : {};
	}

	async #compact(
		event: SessionBeforeCompactEvent,
	): Promise<SessionBeforeCompactResult | undefined> {
		const { log } = this.#options;
		try {
			// Local Unix-socket transport; no TCP connection or DNS lookup is made.
			// nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
			const response = await fetch("http://broker/compaction/compact", {
				unix: this.#options.socket,
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(compactRequest(event)),
				signal: event.signal,
			});
			if (!response.ok) {
				await response.body?.cancel();
				log("compaction falls back to Pi's summary", {
					fallback: `the broker answered ${response.status}`,
				});
				return undefined;
			}
			const answer = (await response.json()) as PiCompactResponse;
			if (!answer.ok) {
				log("compaction falls back to Pi's summary", {
					fallback: answer.fallback,
				});
				return undefined;
			}
			return { compaction: answer.compaction };
		} catch (error) {
			log("compaction falls back to Pi's summary", {
				fallback: `the compact request failed: ${String(error)}`,
			});
			return undefined;
		}
	}

	/** Waits for the reports still on their way, so they reach the host while the turn is bound. */
	async settled(): Promise<void> {
		await Promise.allSettled([...this.#pending]);
	}

	#report(report: PiCompactionReport): Promise<void> {
		const sending = this.#send(report).finally(() =>
			this.#pending.delete(sending),
		);
		this.#pending.add(sending);
		return sending;
	}

	async #send(report: PiCompactionReport): Promise<void> {
		try {
			// Local Unix-socket transport; no TCP connection or DNS lookup is made.
			// nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
			const response = await fetch("http://broker/compaction/report", {
				unix: this.#options.socket,
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(report),
				signal: AbortSignal.timeout(5000),
			});
			await response.body?.cancel();
		} catch (error) {
			this.#options.log("compaction report failed", { error: String(error) });
		}
	}
}
