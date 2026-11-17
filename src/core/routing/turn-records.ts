import { AsyncLocalStorage } from "node:async_hooks";
import type { InboundMessage } from "../contract/channels.ts";
import type { TurnResult } from "../domain/conversation.ts";
import { AgentRunError } from "../domain/errors.ts";
import type { ChannelKey } from "../domain/sessions.ts";
import { HostStoppingError } from "../kernel/errors.ts";

/**
 * The person's messages one admitted turn answers, as the router runs it: the message that started
 * it and those steered into it, and which of them it answered. When a turn run under the admission
 * through `settleTurn` ends with `ok`, whose pipeline then posts the answer, every message the
 * record holds by then counts as answered; a stopped or failed turn answers none, and a message
 * steered in later waits for the next `ok`. A turn runs under the admission when it runs anywhere in
 * the admission's work, its `run` and what that starts, awaited or not, such as a queue task for a
 * thread it opens or a timer it sets; a background turn, an agent's message to another agent and a
 * new agent's opening task run outside it. A shutdown that cuts it before an answer leaves the
 * messages still unanswered for the next process, drops what its turn handed on for later
 * (`onLeave`), and a turn under it that ends later gives a stopped result instead, so its answer is
 * not posted as well.
 */
export class TurnRecord {
	readonly messages: InboundMessage[];
	/** How many of `messages`, from the first, an `ok` turn answered. */
	#answered = 0;
	#left = false;
	readonly #onLeave: (() => Promise<void>)[] = [];
	/** The admission while it runs, plus each turn running under it. */
	#open = 1;
	readonly #closed: () => void;
	readonly #reopened: () => void;

	/**
	 * `closed` runs once the admission and every turn under it have ended, and `reopened` when a turn
	 * under it starts after that, such as one the admission queued without waiting for it.
	 */
	constructor(
		message: InboundMessage,
		closed: () => void,
		reopened: () => void = () => undefined,
	) {
		this.messages = [message];
		this.#closed = closed;
		this.#reopened = reopened;
	}

	/** A turn under it starts. */
	begin(): void {
		if (this.#open === 0) this.#reopened();
		this.#open += 1;
	}

	/** The admission or a turn under it ended. */
	end(): void {
		this.#open -= 1;
		if (this.#open === 0) this.#closed();
	}

	/** Its messages no `ok` turn answered yet. */
	unanswered(): InboundMessage[] {
		return this.messages.slice(this.#answered);
	}

	/** Whether its messages were left for the next process. */
	get left(): boolean {
		return this.#left;
	}

	/**
	 * Runs `task` if its messages are left, as `leave` does, such as removing an agent message kept
	 * for the next start, which the next process sends again when it answers the message anew.
	 */
	onLeave(task: () => Promise<void>): void {
		this.#onLeave.push(task);
	}

	/** Marks its messages left for the next process, and runs what `onLeave` asked, each failure its own. */
	async leave(): Promise<void> {
		this.#left = true;
		await Promise.allSettled(this.#onLeave.splice(0).map((task) => task()));
	}

	/** What a turn that ended under it gives its pipeline; an answer once its messages were left is stopped. */
	settle<R>(result: R): R | StoppedResult {
		if (!isTurnResult(result)) return result;
		if (this.#left) return stoppedByHost();
		if (result.ok) this.#answered = this.messages.length;
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
	async run(
		message: InboundMessage,
		task: () => Promise<unknown>,
	): Promise<void> {
		const { channel } = message;
		const record: TurnRecord = new TurnRecord(
			message,
			() => this.#live.delete(record),
			() => this.#live.add(record),
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
