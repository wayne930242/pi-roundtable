import { QUEUED_MARK, type QueuedChange, STEERED_MARK } from "pi-roundtable";
import type { RoomMessage } from "../api-types.ts";
import type { RoomLog } from "./room-log.ts";

const MESSAGE_ID = /^app-(\d+)$/;

/** The id the app gives the core for a stored message of a room (`say`'s `messageId`). */
export const coreMessageId = (id: number): string => `app-${id}`;

export interface QueuedDeliveryOptions {
	log: Pick<RoomLog, "get" | "setDelivery">;
	/** Whether the room is a host's, whose messages the core does not mark. */
	isHostRoom(room: string): boolean;
	/** Shows a stored message, as it is now, to the sockets that may have its room. */
	show(stored: RoomMessage): void;
}

/**
 * How the owner's messages sent during a turn stand, from the marks the core places on them: a
 * steered message was added to the running turn, a waiting one is queued for its own. Steered and
 * cancelled are kept with the message; queued is held in memory, since the queue itself does not
 * outlive a restart, and goes when the turn starts.
 */
export class QueuedDelivery {
	readonly #options: QueuedDeliveryOptions;
	/** The messages waiting for their own turn, by room. */
	readonly #waiting = new Map<string, Set<number>>();
	/** The messages whose cancel is running, so the mark coming off one is not shown as an ordinary message first. */
	readonly #cancelling = new Set<string>();

	constructor(options: QueuedDeliveryOptions) {
		this.#options = options;
	}

	/** One stored message of a room, as the log keeps it. */
	stored(room: string, id: number): Promise<RoomMessage | undefined> {
		return this.#options.log.get(room, id);
	}

	/** The message with its waiting state, which the log does not keep. */
	shown(message: RoomMessage): RoomMessage {
		return this.#waiting.get(message.room)?.has(message.id) &&
			message.delivery === undefined
			? { ...message, delivery: "queued" }
			: message;
	}

	/** Which stored message a core message id names, in a room of the app's own. */
	#idOf(room: string, messageId: string): number | undefined {
		if (this.#options.isHostRoom(room)) return undefined;
		const found = MESSAGE_ID.exec(messageId);
		return found ? Number(found[1]) : undefined;
	}

	/** The core placed a mark: a steered message is kept as added to the turn, a waiting one is shown as queued. */
	async react(room: string, messageId: string, emoji: string): Promise<void> {
		const id = this.#idOf(room, messageId);
		if (id === undefined) return;
		const { log, show } = this.#options;
		if (emoji === QUEUED_MARK) {
			const waiting = this.#waiting.get(room) ?? new Set<number>();
			waiting.add(id);
			this.#waiting.set(room, waiting);
			const stored = await log.get(room, id);
			if (stored) show(stored);
		} else if (emoji === STEERED_MARK) {
			const stored = await log.setDelivery(room, id, "steered");
			if (stored) show(stored);
		}
	}

	/** The waiting mark came off: the turn of the message started, or it was cancelled. */
	async unreact(room: string, messageId: string, emoji: string): Promise<void> {
		const id = this.#idOf(room, messageId);
		if (id === undefined || emoji !== QUEUED_MARK) return;
		const waiting = this.#waiting.get(room);
		waiting?.delete(id);
		if (waiting?.size === 0) this.#waiting.delete(room);
		// A cancel in progress shows the message once, as cancelled.
		if (this.#cancelling.has(`${room}\0${id}`)) return;
		const stored = await this.#options.log.get(room, id);
		if (stored) this.#options.show(stored);
	}

	/**
	 * Cancels a message that waits for its turn through `cancel`, which asks the host; when the
	 * host cancelled it, the message stays in the room, marked cancelled.
	 */
	async cancel(
		room: string,
		id: number,
		cancel: () => QueuedChange,
	): Promise<QueuedChange> {
		const key = `${room}\0${id}`;
		this.#cancelling.add(key);
		let result: QueuedChange;
		try {
			result = cancel();
		} finally {
			this.#cancelling.delete(key);
		}
		if (result !== "done") return result;
		const stored = await this.#options.log.setDelivery(room, id, "cancelled");
		if (stored) this.#options.show(stored);
		return result;
	}
}
