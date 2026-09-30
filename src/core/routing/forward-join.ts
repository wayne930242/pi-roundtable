import type { InboundMessage } from "../contract/channels.ts";
import type { ChannelKey } from "../sessions.ts";

/** Discord sends a forward's added text as a second message right after the forward. */
export const FORWARD_JOIN_MS = 2_000;

/** A forward without text, waiting for the message Discord sends with its added text. */
interface HeldForward {
	message: InboundMessage;
	timer: ReturnType<typeof setTimeout>;
	release(run: Promise<void>): void;
}

/**
 * Joins a forward without text to the text its author sends right after it, so the two make
 * one turn; a forward nothing follows runs alone once the wait ends.
 */
export class ForwardJoin {
	readonly #waitMs: number;
	readonly #held = new Map<ChannelKey, HeldForward>();

	constructor(waitMs = FORWARD_JOIN_MS) {
		this.#waitMs = waitMs;
	}

	/** Passes each message, or a joined one, to `dispatch`; resolves when its run does. */
	handle(
		message: InboundMessage,
		dispatch: (message: InboundMessage) => Promise<void>,
	): Promise<void> {
		const held = this.#held.get(message.channel);
		if (held && held.message.authorId === message.authorId) {
			this.#held.delete(message.channel);
			clearTimeout(held.timer);
			if (!message.forwarded) {
				const run = dispatch(joinForward(held.message, message));
				held.release(run);
				return run;
			}
			held.release(dispatch(held.message));
		}
		if (!message.forwarded || message.text.trim()) return dispatch(message);
		return new Promise((resolve) => {
			const release = (run: Promise<void>) => resolve(run);
			const timer = setTimeout(() => {
				this.#held.delete(message.channel);
				release(dispatch(message));
			}, this.#waitMs);
			this.#held.set(message.channel, { message, timer, release });
		});
	}
}

/** A forward and the text its author sent right after it, as one message. */
function joinForward(
	forward: InboundMessage,
	text: InboundMessage,
): InboundMessage {
	return {
		...text,
		mentionsBot: forward.mentionsBot || text.mentionsBot,
		attachments: [...forward.attachments, ...text.attachments],
		...(forward.forwarded ? { forwarded: forward.forwarded } : {}),
	};
}
