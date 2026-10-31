import {
	type Admission,
	type ChannelClaim,
	type InboundMessage,
	QUEUED_MARK,
	type QueuedBy,
	type QueuedChange,
	type QueuedMessage,
} from "../contract/channels.ts";
import type { Logger } from "../log.ts";
import type { ChannelKey } from "../sessions.ts";

type TurnAdmission = Extract<Admission, { kind: "turn" }>;

/** A message waiting for its turn, with what runs it; `admission` and `message` follow its edits. */
export interface QueuedEntry {
	readonly claim: ChannelClaim;
	/** The message as the claim last admitted it: the speaker the router resolved, the text as edited. */
	message: InboundMessage;
	admission: TurnAdmission;
	readonly queuedAt: number;
	/** Cancelled while it waited: its turn does not run. */
	cancelled: boolean;
}

/**
 * The messages waiting for their own turn, by channel and message id: the router adds one when
 * the running turn did not take it and takes it out when its turn starts, so a cancel or an edit
 * can only reach a message that has not started. Everything is synchronous, so no cancel or edit
 * races the start of a turn: whichever runs first wins.
 */
export class QueuedMessages {
	readonly #entries = new Map<ChannelKey, Map<string, QueuedEntry>>();
	readonly #logger: Logger;
	readonly #now: () => number;

	constructor(logger: Logger, now: () => number = Date.now) {
		this.#logger = logger;
		this.#now = now;
	}

	add(
		claim: ChannelClaim,
		message: InboundMessage,
		admission: TurnAdmission,
	): QueuedEntry {
		const entry: QueuedEntry = {
			claim,
			message,
			admission,
			queuedAt: this.#now(),
			cancelled: false,
		};
		const channel = this.#entries.get(message.channel) ?? new Map();
		channel.set(message.messageId, entry);
		this.#entries.set(message.channel, channel);
		return entry;
	}

	/** Takes the entry out of the queue's books as its turn starts or the host drops it; false when already out. */
	remove(entry: QueuedEntry): boolean {
		const { channel, messageId } = entry.message;
		const held = this.#entries.get(channel);
		if (held?.get(messageId) !== entry) return false;
		held.delete(messageId);
		if (held.size === 0) this.#entries.delete(channel);
		return true;
	}

	list(channel: ChannelKey): readonly QueuedMessage[] {
		return [...(this.#entries.get(channel)?.values() ?? [])].map((entry) => ({
			messageId: entry.message.messageId,
			...(entry.message.speaker
				? { principalId: entry.message.speaker.principalId }
				: {}),
			text: entry.message.text,
			queuedAt: entry.queuedAt,
		}));
	}

	/**
	 * Cancels the message so its turn never starts. `by` is checked against its author, and absent
	 * when the surface itself says the message is gone, such as a deleted one. `unmark` removes the
	 * waiting mark from the message, which a deleted message cannot take.
	 */
	cancel(
		channel: ChannelKey,
		messageId: string,
		by: QueuedBy | undefined,
		unmark: boolean,
	): QueuedChange {
		const entry = this.#entries.get(channel)?.get(messageId);
		if (!entry) return "unknown";
		if (by && !this.#authored(entry, by)) return "forbidden";
		this.remove(entry);
		entry.cancelled = true;
		entry.admission.dropped?.();
		if (unmark) this.unmark(entry);
		return "done";
	}

	/**
	 * Gives the message's turn the new text: the claim admits the message again with it. When the
	 * claim no longer takes it, the old admission stays and the edit is refused.
	 */
	edit(
		channel: ChannelKey,
		messageId: string,
		by: QueuedBy | undefined,
		text: string,
	): QueuedChange {
		const entry = this.#entries.get(channel)?.get(messageId);
		if (!entry) return "unknown";
		if (by && !this.#authored(entry, by)) return "forbidden";
		if (entry.message.text === text) return "done";
		const message = { ...entry.message, text };
		let next: Admission | undefined;
		try {
			next = entry.claim.admit(message);
		} catch (error) {
			this.#logger.warn(
				{ channel, err: error },
				"a claim failed to admit an edited queued message; the old text stays",
			);
		}
		if (next?.kind !== "turn") return "refused";
		const old = entry.admission;
		entry.message = message;
		entry.admission = next;
		old.dropped?.();
		return "done";
	}

	/** Removes the waiting mark; a failure is logged, since the message may be gone. */
	unmark(entry: QueuedEntry): void {
		const { channel } = entry.message;
		entry.admission.busy
			?.unreact(QUEUED_MARK)
			.catch((error: unknown) =>
				this.#logger.warn(
					{ channel, err: error },
					"the waiting mark of a queued message was not removed",
				),
			);
	}

	#authored(entry: QueuedEntry, by: QueuedBy): boolean {
		const author = entry.message.speaker?.principalId;
		return author !== undefined && author === by.principalId;
	}
}
