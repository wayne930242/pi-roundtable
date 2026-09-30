import type { Tier } from "../speakers.ts";
/**
 * The owner answering inside a running turn: a card in the turn's channel that only he may
 * answer. Unanswered cards expire; a stopped turn cancels its open cards.
 */
export type Approval = "approved" | "declined" | "expired" | "cancelled";

export interface AskOption {
	label: string;
	description?: string;
}

export interface OwnerQuestion {
	question: string;
	/** Up to 25; none means a free-text answer. */
	options: readonly AskOption[];
	/** More than one option may be chosen. */
	multi: boolean;
	/** He may write an answer of his own besides the options. */
	allowOther: boolean;
}

export interface OwnerAnswer {
	/** The chosen options' labels, in the order they were offered. */
	choices: string[];
	/** What he wrote himself, if anything. */
	text?: string;
}

export interface OwnerPrompts {
	/** Asks him to approve an action; `signal` cancels the card when the turn stops. */
	confirm(
		title: string,
		message: string,
		signal?: AbortSignal,
		/** The lowest tier that may approve; the owner only when absent. */
		minTier?: Tier,
	): Promise<Approval>;
	/** Asks him a question; undefined when it expired or was cancelled. */
	ask(
		title: string,
		question: OwnerQuestion,
		signal?: AbortSignal,
	): Promise<OwnerAnswer | undefined>;
}
