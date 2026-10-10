import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { AgentRunError } from "../domain/errors.ts";

/** How long a run told to abort gets to end before its session is disposed of; default for the guard. */
const ABORT_GRACE_MS = 15_000;

/**
 * Aborts a Pi session's run and does not trust the abort to work. A model behind a subprocess that
 * ignores the abort would leave the run, and the queue behind it, waiting for ever, so a run still
 * going once the grace is over has its session disposed of, which drops its model connection, and
 * `gaveUp` rejects so the caller can end the turn as failed.
 */
export class AbortGuard {
	/** Rejects when the abort did not end the run in time; never resolves. */
	readonly gaveUp: Promise<never>;
	readonly #session: Pick<AgentSession, "abort" | "dispose">;
	readonly #graceMs: number;
	readonly #onGiveUp: () => void;
	#reject: (error: Error) => void = () => undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		session: Pick<AgentSession, "abort" | "dispose">,
		options: { graceMs?: number; onGiveUp?: () => void } = {},
	) {
		this.#session = session;
		this.#graceMs = options.graceMs ?? ABORT_GRACE_MS;
		this.#onGiveUp = options.onGiveUp ?? (() => undefined);
		this.gaveUp = new Promise<never>((_resolve, reject) => {
			this.#reject = reject;
		});
		// Nobody waits on it unless the abort fails.
		this.gaveUp.catch(() => undefined);
	}

	/** Aborts the run, and starts the grace the first time. */
	abort(): void {
		void this.#session.abort();
		this.#timer ??= setTimeout(() => {
			this.#onGiveUp();
			try {
				this.#session.dispose();
			} catch {
				// A session that cannot be disposed of is dropped all the same.
			}
			this.#reject(
				new AgentRunError(
					"the run did not stop after it was aborted, so its session was disposed of",
				),
			);
		}, this.#graceMs);
	}

	/** The run ended: no session is disposed of any more. */
	release(): void {
		clearTimeout(this.#timer);
	}
}
