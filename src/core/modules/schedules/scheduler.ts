import type { ScheduledOutcome } from "../../contract/channels.ts";
import type { Logger } from "../../log.ts";
import { nextRun } from "./recurrence.ts";
import type { Schedule, ScheduleStore } from "./schedule-store.ts";

export type { ScheduledOutcome };

export interface ScheduledRunner {
	/** Runs one due schedule in its channel and posts the answer there; never rejects. */
	runScheduled(schedule: Schedule, firedAt: Date): Promise<ScheduledOutcome>;
}

/** A run found this late, for example after the service was down, is skipped instead of run. */
export const LATE_LIMIT_MS = 12 * 3_600_000;

export interface SchedulerOptions {
	store: Pick<ScheduleStore, "due" | "claim" | "recordStatus">;
	runner: ScheduledRunner;
	logger: Logger;
	intervalMs?: number;
	/** Replaceable in tests. */
	now?: () => Date;
}

function statusText(outcome: ScheduledOutcome): string {
	switch (outcome.status) {
		case "ran":
			return "ran";
		case "failed":
			return `failed: ${outcome.error}`.slice(0, 300);
		case "skipped":
			return `skipped: ${outcome.reason}`;
	}
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
		await Promise.all([...this.#running]);
	}

	async #fire(schedule: Schedule, firedAt: Date): Promise<void> {
		const { store, runner, logger } = this.#options;
		logger.info(
			{ schedule: schedule.id, channel: schedule.channel, mode: schedule.mode },
			"schedule firing",
		);
		const outcome = await runner.runScheduled(schedule, firedAt);
		logger.info({ schedule: schedule.id, outcome }, "schedule finished");
		await store
			.recordStatus(schedule.id, statusText(outcome))
			.catch((error: unknown) =>
				logger.error(
					{ schedule: schedule.id, err: error },
					"schedule status not saved",
				),
			);
	}
}
