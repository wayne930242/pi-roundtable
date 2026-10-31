import type { HoldRefusal } from "../domain/progress.ts";
import { assistantName } from "../i18n/index.ts";
import type {
	OwnerQuestion,
	Prompts,
	PromptWait,
	Questionnaire,
} from "../interactions/prompts.ts";
import { turnBudget } from "./turn-budget.ts";

/**
 * A run's way to ask the owner while it works. A turn they started or a report turn binds the
 * cards of its channel, and a coding worker those of its dispatch thread; a schedule's turn, or
 * a session with no Discord channel, leaves the slot empty and held actions wait for their next
 * message instead. The slot also counts how long the run waited on them, which its time limit
 * leaves out.
 */
export class PromptSlot {
	#prompts: Prompts | undefined;
	#beforeCard: (() => Promise<void>) | undefined;
	#yolo: (() => boolean) | undefined;
	#asker = assistantName();
	#open = 0;
	#openSince = 0;
	#waited = 0;
	#refused = new Map<string, HoldRefusal>();

	/**
	 * Binds the turn's prompts; `asker` names who asks, the assistant or an agent. `beforeCard`
	 * runs before each card opens, such as posting the text the turn wrote before it. `yolo` says
	 * whether the turn's conversation is in yolo mode now, read each time a card asks.
	 */
	bind(
		prompts: Prompts | undefined,
		asker: string,
		beforeCard?: () => Promise<void>,
		yolo?: () => boolean,
	): void {
		this.#prompts = prompts;
		this.#beforeCard = beforeCard;
		this.#yolo = yolo;
		this.#asker = asker;
		this.#open = 0;
		this.#waited = 0;
		this.#refused.clear();
	}

	/** Notes that a hold refused a tool call, for the progress of the turn to report once. */
	refuse(toolCallId: string, refusal: HoldRefusal): void {
		this.#refused.set(toolCallId, refusal);
	}

	/** Why a hold refused a tool call, once; undefined when it did not. */
	refusalOf(toolCallId: string): HoldRefusal | undefined {
		const refusal = this.#refused.get(toolCallId);
		this.#refused.delete(toolCallId);
		return refusal;
	}

	unbind(): void {
		this.#prompts = undefined;
		this.#beforeCard = undefined;
		this.#yolo = undefined;
	}

	get asker(): string {
		return this.#asker;
	}

	/** Whether the bound turn's conversation is in yolo mode now; false with none bound. */
	get yolo(): boolean {
		return this.#yolo?.() === true;
	}

	/** The turn's prompts, each open card counted as waiting; undefined when none is bound. */
	get prompts(): Prompts | undefined {
		const prompts = this.#prompts;
		if (!prompts) return undefined;
		const { questionnaire } = prompts;
		return {
			...(prompts.asks && questionnaire
				? {
						asks: prompts.asks,
						questionnaire: (
							title: string,
							asked: Questionnaire,
							signal?: AbortSignal,
							wait?: PromptWait,
						) =>
							this.#waiting(() =>
								questionnaire.call(prompts, title, asked, signal, wait),
							),
					}
				: {}),
			confirm: (title, message, signal, minTier, wait, details, options) =>
				this.#waiting(() =>
					prompts.confirm(
						title,
						message,
						signal,
						minTier,
						wait,
						details,
						options,
					),
				),
			ask: (title, question: OwnerQuestion, signal, wait) =>
				this.#waiting(() => prompts.ask(title, question, signal, wait)),
		};
	}

	/**
	 * The turn's prompts as bound, an open card not counted as waiting; for a card the turn keeps
	 * working beside, such as the one its time limit posts.
	 */
	get cards(): Prompts | undefined {
		return this.#prompts;
	}

	/** Time this turn has spent with at least one card open. */
	waitedMs(now = Date.now()): number {
		return this.#waited + (this.#open > 0 ? now - this.#openSince : 0);
	}

	async #waiting<T>(ask: () => Promise<T>): Promise<T> {
		await this.#beforeCard?.();
		if (this.#open++ === 0) this.#openSince = Date.now();
		try {
			return await ask();
		} finally {
			if (--this.#open === 0) this.#waited += Date.now() - this.#openSince;
		}
	}
}

/** A fresh slot, for a run that asks the owner while it works. */
export function promptSlot(): PromptSlot {
	return new PromptSlot();
}

/**
 * Calls `expire` once the run has worked `ms`, not counting time the slot spent waiting on the
 * owner's cards; returns a function that cancels it. It is a turn budget with nothing to renew,
 * so it looks again at a run that waits on a card no oftener than `turnBudget` does.
 */
export function workTimeout(
	ms: number,
	slot: Pick<PromptSlot, "waitedMs">,
	expire: () => void,
): () => void {
	return turnBudget(ms, ms, slot, () => expire()).cancel;
}
