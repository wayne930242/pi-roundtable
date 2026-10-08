import { OWNER_TARGET } from "../../agents/agent-claim.ts";
import type {
	BackgroundRunsAs,
	BackgroundTurn,
	ConversationPort,
	ScheduledOutcome,
} from "../../contract/channels.ts";
import type { ChannelKey } from "../../domain/conversation.ts";
import type { Logger } from "../../log.ts";
import { systemTurn } from "../../routing/system-turns.ts";
import type { BackgroundTurns } from "../../services.ts";
import { zonedStamp } from "../../time.ts";
import {
	type DelegationJob,
	type DelegationOutcome,
	delegatedTurnText,
} from "../delegation/delegator.ts";
import type { PrecheckFinding } from "../schedules/prechecks.ts";
import type { Schedule } from "../schedules/schedule-store.ts";
import { scheduledTurnText } from "../schedules/schedule-tools.ts";

export interface BackgroundTurnsOptions {
	conversations: Pick<ConversationPort, "background" | "runsAs">;
	/** Who a turn the process itself starts, such as a logged error's report, is written by. */
	system: { id: string; name: string };
	/**
	 * The principal a schedule's creator id stands for, such as the primary owner for 0.8's
	 * `remote-mcp`; without it, or when it knows none, the id is taken as the principal's.
	 */
	principalOf?: (id: string) => Promise<string | undefined>;
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

	/** A due schedule's turn, run as its creator's; with what its precheck found, when it has one. */
	async runScheduled(
		schedule: Schedule,
		firedAt: Date,
		finding?: PrecheckFinding,
	): Promise<ScheduledOutcome> {
		return this.#options.conversations.background(
			await this.#scheduled(schedule, firedAt, finding),
		);
	}

	/** Who a due schedule's turn would run as now, checked as the turn is. */
	async runsAs(schedule: Schedule): Promise<BackgroundRunsAs> {
		return this.#options.conversations.runsAs(
			await this.#scheduled(schedule, new Date()),
		);
	}

	/** A due schedule's turn, by its creator: the principal their id stands for, at the schedule's tier. */
	async #scheduled(
		schedule: Schedule,
		firedAt: Date,
		finding?: PrecheckFinding,
	): Promise<BackgroundTurn> {
		const { createdById } = schedule;
		const principalId =
			(await this.#options.principalOf?.(createdById)) ?? createdById;
		return {
			channel: schedule.channel,
			target: schedule.target,
			author: { principalId, id: createdById, name: schedule.createdByName },
			tier: schedule.createdTier,
			turnId: `schedule-${schedule.id}-${firedAt.getTime()}`,
			text: scheduledTurnText(schedule, firedAt, finding),
		};
	}

	/** A delegated task's report, answered in its channel under the same rules as a schedule. */
	async runDelegated(
		job: DelegationJob,
		result: DelegationOutcome,
	): Promise<void> {
		const outcome = await this.#options.conversations.background({
			channel: job.channel,
			target: job.target,
			author: {
				principalId: job.author.principalId,
				id: job.author.id,
				name: job.author.name,
			},
			tier: job.author.tier,
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

	/**
	 * The process's own logged error, reported to an agent in its channel as a report turn: the
	 * host's own, at the owner tier, as in 0.8.
	 */
	runErrorReport(channel: ChannelKey, text: string): Promise<ScheduledOutcome> {
		return this.#options.conversations.background(
			systemTurn({
				channel,
				target: OWNER_TARGET.name,
				author: this.#options.system,
				tier: "owner",
				turnId: `error-${Date.now()}`,
				text,
				report: true,
			}),
		);
	}
}
