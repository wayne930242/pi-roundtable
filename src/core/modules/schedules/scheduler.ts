import type {
	BackgroundRunsAs,
	ScheduledOutcome,
} from "../../contract/channels.ts";
import type { HoldCheck } from "../../holds.ts";
import type { Logger } from "../../log.ts";
import type { ScheduleStore } from "../../services.ts";
import {
	type PrecheckFinding,
	type PrecheckRegistry,
	SCRIPT_PRECHECK,
} from "./prechecks.ts";
import { nextRun } from "./recurrence.ts";
import { SchedulePrechecks } from "./schedule-prechecks.ts";
import type { Schedule } from "./schedule-store.ts";

export type { ScheduledOutcome };

export interface ScheduledRunner {
	/** Runs one due schedule in its channel and posts the answer there, with what its precheck found; never rejects. */
	runScheduled(
		schedule: Schedule,
		firedAt: Date,
		finding?: PrecheckFinding,
	): Promise<ScheduledOutcome>;
	/**
	 * Who the schedule's turn would run as now, asked before its precheck: a precheck runs only for
	 * a creator who may run the turn, at the tier it would run at. Throws when that cannot be told.
	 */
	runsAs(schedule: Schedule): Promise<BackgroundRunsAs>;
}

/** How long stop waits for running prechecks to clean up after aborting them. */
export const PRECHECK_STOP_MS = 15_000;

/** A run found this late, for example after the service was down, is skipped instead of run. */
export const LATE_LIMIT_MS = 12 * 3_600_000;

export interface SchedulerOptions {
	store: Pick<ScheduleStore, "due" | "claim" | "recordStatus">;
	runner: ScheduledRunner;
	/** The host's prechecks and script runner; without them, a schedule that has one runs with that as its error. */
	prechecks?: Pick<PrecheckRegistry, "get"> &
		Partial<Pick<PrecheckRegistry, "scriptRunner">>;
	/**
	 * The host's hold rules, read when a script saved before its tools were recorded runs: it runs
	 * only if it calls no held tool. Without them, such a script does not run.
	 */
	holds?: () => HoldCheck;
	/** Posts a skipping precheck's note in the schedule's channel as the bot's own message, which starts no turn. */
	notify?: (schedule: Schedule, note: string) => Promise<void>;
	logger: Logger;
	intervalMs?: number;
	/** Replaceable in tests. */
	now?: () => Date;
}

const STATUS_CHARS = 300;

function statusText(outcome: ScheduledOutcome): string {
	switch (outcome.status) {
		case "ran":
			return "ran";
		case "failed":
			return `failed: ${outcome.error}`;
		case "skipped":
			return `skipped: ${outcome.reason}`;
		default:
			return outcome satisfies never;
	}
}

/** How the precheck let the turn run, before the turn's own outcome. */
function precheckPrefix(finding: PrecheckFinding | undefined): string {
	if (!finding) return "";
	return "error" in finding
		? `precheck failed (${finding.error}), woke; `
		: "woken by precheck; ";
}

/**
 * Checks for due schedules on an interval. Each due schedule is claimed first, moved to its
 * next run or deleted, so a slow or failing run never fires twice; missed runs are not caught up.
 */
export class Scheduler {
	readonly #options: SchedulerOptions;
	readonly #running = new Set<Promise<void>>();
	readonly #stopping = new AbortController();
	readonly #prechecks: SchedulePrechecks;
	#timer: ReturnType<typeof setInterval> | undefined;
	#ticking = false;

	constructor(options: SchedulerOptions) {
		this.#options = options;
		this.#prechecks = new SchedulePrechecks({
			prechecks: options.prechecks,
			holds: options.holds,
			logger: options.logger,
			signal: this.#stopping.signal,
		});
	}

	start(): void {
		this.#timer = setInterval(
			() => void this.tick(),
			this.#options.intervalMs ?? 30_000,
		);
		void this.tick();
	}

	/**
	 * Stops checking, aborts running prechecks, and waits up to PRECHECK_STOP_MS for them to clean
	 * up, so a sandboxed script never outlives the host. A turn already running is left to the
	 * host's drain; no precheck that ends now starts one.
	 */
	async stop(): Promise<void> {
		clearInterval(this.#timer);
		this.#stopping.abort();
		await this.#prechecks.drain(PRECHECK_STOP_MS);
	}

	/** Claims every due schedule and starts its run; runs continue after tick resolves. */
	async tick(): Promise<void> {
		if (this.#ticking || this.#stopping.signal.aborted) return;
		this.#ticking = true;
		const { store, logger } = this.#options;
		try {
			const now = this.#options.now?.() ?? new Date();
			for (const schedule of await store.due(now)) {
				if (this.#stopping.signal.aborted) break;
				const claimed = await store.claim(
					schedule,
					nextRun(schedule.recurrence, now),
					now,
				);
				if (!claimed) continue;
				if (this.#stopping.signal.aborted) {
					await this.#record(
						schedule,
						"skipped: the host stopped before its run",
					);
					break;
				}
				if (now.getTime() - schedule.nextRun.getTime() > LATE_LIMIT_MS) {
					logger.warn(
						{ schedule: schedule.id, due: schedule.nextRun },
						"schedule missed its run",
					);
					await store.recordStatus(
						schedule.id,
						"skipped: missed while offline",
					);
					continue;
				}
				const run = this.#fire(schedule, now).finally(() =>
					this.#running.delete(run),
				);
				this.#running.add(run);
			}
		} catch (error) {
			logger.error({ err: error }, "schedule check failed");
		} finally {
			this.#ticking = false;
		}
	}

	/** Resolves once every started run has finished. */
	async idle(): Promise<void> {
		// pi-lens-ignore: no-single-promise-in-promise-methods — the spread holds every run in flight, none to many; it is not one promise
		await Promise.all([...this.#running]);
	}

	async #fire(schedule: Schedule, firedAt: Date): Promise<void> {
		const { runner, logger } = this.#options;
		let finding: PrecheckFinding | undefined;
		const name =
			schedule.precheck ??
			(schedule.precheckScript ? SCRIPT_PRECHECK : undefined);
		if (name) {
			// A creator who may not run the turn now, such as one disabled, runs no precheck either.
			const runs = await this.#runsAs(schedule);
			if (this.#stopping.signal.aborted) {
				await this.#record(
					schedule,
					"skipped: the host stopped before its run",
				);
				return;
			}
			if ("skipped" in runs) {
				logger.info(
					{ schedule: schedule.id, reason: runs.skipped },
					"schedule skipped before its precheck",
				);
				await this.#record(schedule, `skipped: ${runs.skipped}`);
				return;
			}
			const decision = await this.#prechecks.run(
				schedule,
				name,
				firedAt,
				runs.speaker.tier,
			);
			if (this.#stopping.signal.aborted) {
				await this.#record(
					schedule,
					"skipped: the host stopped during its precheck",
				);
				return;
			}
			if (decision.kind === "skip") {
				await this.#skip(schedule, decision.note);
				return;
			}
			finding =
				decision.kind === "wake"
					? { precheck: name, context: decision.context }
					: { precheck: name, error: decision.error };
		}
		logger.info(
			{
				schedule: schedule.id,
				channel: schedule.channel,
				target: schedule.target,
			},
			"schedule firing",
		);
		const outcome = await runner.runScheduled(schedule, firedAt, finding);
		logger.info({ schedule: schedule.id, outcome }, "schedule finished");
		await this.#record(
			schedule,
			`${precheckPrefix(finding)}${statusText(outcome)}`,
		);
	}

	/** Who the schedule runs as; a failure to tell is a reason to skip it, as its turn would not run. */
	async #runsAs(schedule: Schedule): Promise<BackgroundRunsAs> {
		try {
			return await this.#options.runner.runsAs(schedule);
		} catch (error) {
			return {
				skipped: `whom it runs as could not be checked (${error instanceof Error ? error.message : String(error)})`,
			};
		}
	}

	/** Records a run the precheck skipped and posts its note; a note that cannot be posted is logged. */
	async #skip(schedule: Schedule, note: string | undefined): Promise<void> {
		const { notify, logger } = this.#options;
		if (note && notify)
			await notify(schedule, note).catch((error: unknown) =>
				logger.warn(
					{ schedule: schedule.id, err: error },
					"precheck note not posted",
				),
			);
		await this.#record(
			schedule,
			note ? `skipped by precheck (${note})` : "skipped by precheck",
		);
	}

	async #record(schedule: Schedule, status: string): Promise<void> {
		const { store, logger } = this.#options;
		await store
			.recordStatus(schedule.id, status.slice(0, STATUS_CHARS))
			.catch((error: unknown) =>
				logger.error(
					{ schedule: schedule.id, err: error },
					"schedule status not saved",
				),
			);
	}
}
