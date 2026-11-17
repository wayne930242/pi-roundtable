import { AsyncLocalStorage } from "node:async_hooks";
import type { InboundMessage } from "../contract/channels.ts";
import type { TurnResult } from "../domain/conversation.ts";
import { AgentRunError } from "../domain/errors.ts";
import type { ChannelKey } from "../domain/sessions.ts";
import { HostStoppingError } from "../kernel/errors.ts";

/**
 * The person's messages one admitted turn answers, as the router runs it: the message that started
 * it and those steered into it, and whether it answered them. A turn counts as answered once a turn
 * run under its admission, through `settleTurn`, ends with `ok`, whose pipeline then posts the
 * answer; a stopped or failed turn does not. A shutdown that cuts it before that leaves its messages
 * for the next process, and a turn under it that ends later gives a stopped result instead, so its
 * answer is not posted as well.
 */
export class TurnRecord {
	readonly messages: InboundMessage[];
	#answered = false;
	#left = false;
	/** The admission while it runs, plus each turn running under it. */
	#open = 1;
	readonly #closed: () => void;

	/** `closed` runs once the admission and every turn under it have ended. */
	constructor(message: InboundMessage, closed: () => void) {
		this.messages = [message];
		this.#closed = closed;
	}

	/** A turn under it starts. */
	begin(): void {
		this.#open += 1;
	}

	/** The admission or a turn under it ended. */
	end(): void {
		this.#open -= 1;
		if (this.#open === 0) this.#closed();
	}

	/** Marks its messages left for the next process, unless a turn answered them; whether it did. */
	leave(): boolean {
		if (this.#answered) return false;
		this.#left = true;
		return true;
	}

	/** What a turn that ended under it gives its pipeline; an answer once its messages were left is stopped. */
	settle<R>(result: R): R | StoppedResult {
		if (!isTurnResult(result)) return result;
		if (this.#left) return stoppedByHost();
		if (result.ok) this.#answered = true;
		return result;
	}
}

type StoppedResult = { ok: false; error: AgentRunError; stopped: true };

const stoppedByHost = (): StoppedResult => ({
	ok: false,
	error: new AgentRunError(new HostStoppingError().message),
	stopped: true,
});

function isTurnResult(value: unknown): value is TurnResult {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { ok?: unknown }).ok === "boolean"
	);
}

const current = new AsyncLocalStorage<TurnRecord | undefined>();

/** Runs `task` with `record` as the turn record of everything it starts; undefined runs it outside any. */
export function underRecord<T>(
	record: TurnRecord | undefined,
	task: () => T,
): T {
	return current.run(record, task);
}

/** The turn record of the admission the caller runs under, if any. */
export function currentRecord(): TurnRecord | undefined {
	return current.getStore();
}

/**
 * The records of the admitted turns still running, or with a turn running under them: the router
 * runs each turn admission through `run`, and the host marks the ones the drain limit finds with
 * `cut`, to leave those that did not answer once the abort grace is over.
 */
export class RunningTurns {
	readonly #live = new Set<TurnRecord>();
	/** Each channel's admission running in its queue, which a steered message joins. */
	readonly #running = new Map<ChannelKey, TurnRecord>();
	#cut: TurnRecord[] = [];

	/** Runs the admission of `message` under a new record, as its channel's running turn. */
	async run(message: InboundMessage, task: () => Promise<void>): Promise<void> {
		const { channel } = message;
		const record: TurnRecord = new TurnRecord(message, () =>
			this.#live.delete(record),
		);
		this.#live.add(record);
		this.#running.set(channel, record);
		try {
			await underRecord(record, task);
		} finally {
			if (this.#running.get(channel) === record) this.#running.delete(channel);
			record.end();
		}
	}

	/** The channel's running turn, to add a message steered into it; undefined when none runs. */
	running(channel: ChannelKey): TurnRecord | undefined {
		return this.#running.get(channel);
	}

	/** Marks every record still open as cut: the drain limit found its turn running. */
	cut(): void {
		this.#cut.push(...this.#live);
	}

	/** The records marked cut, each once. */
	takeCut(): TurnRecord[] {
		return [...new Set(this.#cut.splice(0))];
	}
}
