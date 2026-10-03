import type { ScheduledOutcome } from "../../contract/channels.ts";
import type { Logger } from "../../log.ts";
import type { ScheduleStore } from "../../services.ts";
import {
	type PrecheckFinding,
	type PrecheckOutcome,
	type PrecheckRegistry,
	runPrecheck,
} from "./prechecks.ts";
import { nextRun } from "./recurrence.ts";
import type { Schedule } from "./schedule-store.ts";

export type { ScheduledOutcome };

export interface ScheduledRunner {
	/** Runs one due schedule in its channel and posts the answer there, with what its precheck found; never rejects. */
	runScheduled(
		schedule: Schedule,
		firedAt: Date,
		finding?: PrecheckFinding,
	): Promise<ScheduledOutcome>;
}

/** A run found this late, for example after the service was down, is skipped instead of run. */
export const LATE_LIMIT_MS = 12 * 3_600_000;

export interface SchedulerOptions {
	store: Pick<ScheduleStore, "due" | "claim" | "recordStatus">;
	runner: ScheduledRunner;
	/** The host's prechecks; without them, a schedule that names one runs with that as its error. */
	prechecks?: Pick<PrecheckRegistry, "get">;
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
	#timer: ReturnType<typeof setInterval> | undefined;
	#ticking = false;

	constructor(options: SchedulerOptions) {
		this.#options = options;
	}

	start(): void {
		this.#timer = setInterval(
			() => void this.tick(),
			this.#options.intervalMs ?? 30_000,
		);
		void this.tick();
	}

	stop(): void {
		clearInterval(this.#timer);
	}

	/** Claims every due schedule and starts its run; runs continue after tick resolves. */
	async tick(): Promise<void> {
		if (this.#ticking) return;
		this.#ticking = true;
		const { store, logger } = this.#options;
		try {
			const now = this.#options.now?.() ?? new Date();
			for (const schedule of await store.due(now)) {
				const claimed = await store.claim(
					schedule,
					nextRun(schedule.recurrence, now),
					now,
				);
				if (!claimed) continue;
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
		if (schedule.precheck) {
			const decision = await this.#precheck(
				schedule,
				schedule.precheck,
				firedAt,
			);
			if (decision.kind === "skip") {
				await this.#skip(schedule, decision.note);
				return;
			}
			finding =
				decision.kind === "wake"
					? { precheck: schedule.precheck, context: decision.context }
					: { precheck: schedule.precheck, error: decision.error };
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

	/** Runs the schedule's precheck; a missing one fails like a throw, so the turn still runs. */
	async #precheck(
		schedule: Schedule,
		name: string,
		firedAt: Date,
	): Promise<PrecheckOutcome> {
		const { prechecks, logger } = this.#options;
		let decision: PrecheckOutcome;
		try {
			const precheck = prechecks?.get(name);
			decision = precheck
				? await runPrecheck(precheck, { schedule, firedAt })
				: { kind: "failed", error: "no precheck of that name is registered" };
		} catch (error) {
			decision = {
				kind: "failed",
				error: `the precheck could not be looked up: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		// A warning, not an error: the woken turn carries the error already, and an error line would
		// wake the ops agent's report turn for the same failure.
		if (decision.kind === "failed")
			logger.warn(
				{ schedule: schedule.id, precheck: name, error: decision.error },
				"precheck failed; the scheduled turn runs with the error",
			);
		else
			logger.info(
				{
					schedule: schedule.id,
					precheck: name,
					wake: decision.kind === "wake",
				},
				"precheck decided",
			);
		return decision;
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
