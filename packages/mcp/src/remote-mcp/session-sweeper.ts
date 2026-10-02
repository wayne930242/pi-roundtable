import type { ChannelKey, Logger } from "pi-roundtable";
import { remoteChannel } from "./remote-agent.ts";
import type { RemoteSessionStore } from "./remote-session-store.ts";

/** An outside agent's conversation idle this long is deleted. */
export const REMOTE_SESSION_IDLE_MS = 14 * 86_400_000;
const SWEEP_INTERVAL_MS = 86_400_000;

export interface RemoteSessionSweeperOptions {
	sessions: Pick<RemoteSessionStore, "idleSince">;
	/** Deletes the conversation, its archives, and its session; `busy` while a turn runs there. */
	deleteConversation(channel: ChannelKey): Promise<"deleted" | "busy">;
	logger: Logger;
	idleMs?: number;
	intervalMs?: number;
	/** Replaceable in tests. */
	now?: () => Date;
}

/**
 * Deletes outside agents' conversations left idle, at start and then daily, the way the host removes
 * a conversation. A busy one is left for the next sweep.
 */
export class RemoteSessionSweeper {
	readonly #options: RemoteSessionSweeperOptions;
	#timer: ReturnType<typeof setInterval> | undefined;
	#sweeping = false;

	constructor(options: RemoteSessionSweeperOptions) {
		this.#options = options;
	}

	start(): void {
		this.#timer = setInterval(
			() => void this.sweep(),
			this.#options.intervalMs ?? SWEEP_INTERVAL_MS,
		);
		void this.sweep();
	}

	stop(): void {
		clearInterval(this.#timer);
	}

	async sweep(): Promise<void> {
		if (this.#sweeping) return;
		this.#sweeping = true;
		const { sessions, deleteConversation, logger } = this.#options;
		try {
			const now = this.#options.now?.() ?? new Date();
			const cutoff = new Date(
				now.getTime() - (this.#options.idleMs ?? REMOTE_SESSION_IDLE_MS),
			);
			const deleted: string[] = [];
			const busy: string[] = [];
			for (const id of await sessions.idleSince(cutoff)) {
				try {
					const outcome = await deleteConversation(remoteChannel(id));
					(outcome === "deleted" ? deleted : busy).push(id);
				} catch (error) {
					logger.error(
						{ err: error, sessionId: id },
						"idle outside-agent conversation not deleted",
					);
				}
			}
			if (deleted.length > 0 || busy.length > 0)
				logger.info(
					{ deleted, busy, cutoff: cutoff.toISOString() },
					"idle outside-agent conversations swept",
				);
		} catch (error) {
			logger.error({ err: error }, "outside-agent conversation sweep failed");
		} finally {
			this.#sweeping = false;
		}
	}
}
