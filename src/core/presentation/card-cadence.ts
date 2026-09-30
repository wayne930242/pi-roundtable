import type { ChannelKey } from "../domain/conversation.ts";
import type { Expression } from "../domain/expression.ts";

/** A channel quiet this long starts a new conversation, whose first reply shows a card. */
export const CONVERSATION_GAP_MS = 30 * 60_000;

/**
 * Decides which replies carry a card: one that opens a conversation or changes its tone.
 * Kept in memory; after a restart every channel's next reply opens a conversation.
 */
export class CardCadence {
	readonly #channels = new Map<
		ChannelKey,
		{ lastReplyAt: number; lastCard: Expression | undefined }
	>();

	/** Records a reply about to be posted and says whether it shows a card. */
	shows(
		channel: ChannelKey,
		expression: Expression,
		failed: boolean,
		now = Date.now(),
	): boolean {
		const state = this.#channels.get(channel);
		const card =
			failed ||
			!state ||
			now - state.lastReplyAt >= CONVERSATION_GAP_MS ||
			(expression !== "neutral" && expression !== state.lastCard);
		this.#channels.set(channel, {
			lastReplyAt: now,
			lastCard: card ? expression : state?.lastCard,
		});
		return card;
	}

	/** The channel's next reply opens a conversation again. */
	forget(channel: ChannelKey): void {
		this.#channels.delete(channel);
	}
}
