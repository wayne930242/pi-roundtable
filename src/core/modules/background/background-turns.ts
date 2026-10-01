import { OWNER_TARGET } from "../../agents/agent-claim.ts";
import type {
	ConversationPort,
	ScheduledOutcome,
} from "../../contract/channels.ts";
import type { ChannelKey } from "../../domain/conversation.ts";
import type { Logger } from "../../log.ts";
import type { BackgroundTurns } from "../../services.ts";
import { zonedStamp } from "../../time.ts";
import {
	type DelegationJob,
	type DelegationOutcome,
	delegatedTurnText,
} from "../delegation/delegator.ts";
import type { Schedule } from "../schedules/schedule-store.ts";
import { scheduledTurnText } from "../schedules/schedule-tools.ts";

export interface BackgroundTurnsOptions {
	conversations: Pick<ConversationPort, "background">;
	/** Who a turn the process itself starts, such as a logged error's report, is written by. */
	system: { id: string; name: string };
	logger: Logger;
}

/**
 * Turns nobody wrote, each answered in its channel by the claim that owns it: a due schedule's,
 * a delegated task's report, and the process's own logged error.
 */
export class ConversationBackgroundTurns implements BackgroundTurns {
	readonly #options: BackgroundTurnsOptions;

	constructor(options: BackgroundTurnsOptions) {
		this.#options = options;
	}

	/** A due schedule's turn, run as its creator's. */
	runScheduled(schedule: Schedule, firedAt: Date): Promise<ScheduledOutcome> {
		return this.#options.conversations.background({
			channel: schedule.channel,
			target: schedule.target,
			author: { id: schedule.createdById, name: schedule.createdByName },
			tier: schedule.createdTier,
			turnId: `schedule-${schedule.id}-${firedAt.getTime()}`,
			text: scheduledTurnText(schedule, firedAt),
		});
	}

	/** A delegated task's report, answered in its channel under the same rules as a schedule. */
	async runDelegated(
		job: DelegationJob,
		result: DelegationOutcome,
	): Promise<void> {
		const outcome = await this.#options.conversations.background({
			channel: job.channel,
			target: job.target,
			author: job.author,
			...(job.author.tier ? { tier: job.author.tier } : {}),
			turnId: `delegate-${job.id}-${job.startedAt.getTime()}`,
			text: delegatedTurnText(job, result, zonedStamp(job.startedAt)),
			report: true,
		});
		if (outcome.status !== "ran")
			this.#options.logger.warn(
				{ job: job.id, channel: job.channel, outcome },
				"delegated report not answered",
			);
	}

	/** The process's own logged error, reported to an agent in its channel as a report turn. */
	runErrorReport(channel: ChannelKey, text: string): Promise<ScheduledOutcome> {
		return this.#options.conversations.background({
			channel,
			target: OWNER_TARGET.name,
			author: this.#options.system,
			turnId: `error-${Date.now()}`,
			text,
			report: true,
		});
	}
}
