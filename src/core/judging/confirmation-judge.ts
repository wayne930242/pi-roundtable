import type { Judge } from "../contract/providers.ts";
import type { PendingConfirmation } from "../domain/conversation.ts";
import type { Logger } from "../log.ts";

export interface ConfirmationJudgeOptions {
	judge: Judge;
	threshold: number;
	/** How the judge's instructions name the assistant that held the actions. */
	assistant?: string;
	logger: Logger;
}

/** Decides with the judge whether the owner's reply confirms the actions the assistant held for them. */
export class ConfirmationJudge {
	readonly #options: ConfirmationJudgeOptions;

	constructor(options: ConfirmationJudgeOptions) {
		this.#options = options;
	}

	/** True only for a confident approval; a failed request counts as no approval. */
	async approves(
		pending: PendingConfirmation,
		reply: string,
	): Promise<boolean> {
		const {
			judge,
			threshold,
			logger,
			assistant = "The assistant",
		} = this.#options;
		try {
			const answer = await judge.askChoice(
				{
					held_actions: pending.calls.map((call) => call.action),
					owner_reply: reply,
				},
				"confirmation",
				{
					type: "choice",
					instructions: `${assistant} asked the owner to confirm the held_actions before running them. Does owner_reply give the go-ahead for them as described?`,
					criteria: {
						approve: `The owner clearly agrees that ${assistant} should go ahead with the held actions as described.`,
						decline:
							"The owner refuses, cancels, postpones, or asks to change the actions first.",
						other:
							"The reply is about something else or does not clearly answer.",
					},
				},
			);
			const approved =
				answer.choice === "approve" && answer.confidence >= threshold;
			logger.info(
				{
					choice: answer.choice,
					confidence: answer.confidence,
					approved,
					actions: pending.calls.map((call) => call.action),
				},
				"confirmation decided",
			);
			return approved;
		} catch (error) {
			logger.warn({ err: error }, "confirmation request failed; not approving");
			return false;
		}
	}
}
