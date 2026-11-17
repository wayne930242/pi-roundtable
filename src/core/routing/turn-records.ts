import { AsyncLocalStorage } from "node:async_hooks";
import type { InboundMessage } from "../contract/channels.ts";
import type { TurnResult } from "../domain/conversation.ts";
import { AgentRunError } from "../domain/errors.ts";
import type { ChannelKey } from "../domain/sessions.ts";
import { HostStoppingError } from "../kernel/errors.ts";

/** What a record tells its `RunningTurns`. */
interface RecordHooks {
	/** The admission and every turn and queue task under it have ended. */
	closed(): void;
	/** A turn or queue task under it starts after it closed. */
	reopened(): void;
	/** The stopping host refused a turn under it before it answered. */
	refused(): void;
}

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
	readonly #messages: InboundMessage[];
	readonly #answered = new Set<InboundMessage>();
	/** How many turns under it ended `ok`. */
	#answers = 0;
	#left = false;
	readonly #onLeave: { task: () => Promise<void>; since: number }[] = [];
	/** The admission while it runs, plus each turn and queue task running under it. */
	#open = 1;
	readonly #hooks: RecordHooks;

	constructor(message: InboundMessage, hooks: Partial<RecordHooks> = {}) {
		this.#messages = [message];
		const none = () => undefined;
		this.#hooks = {
			closed: hooks.closed ?? none,
			reopened: hooks.reopened ?? none,
			refused: hooks.refused ?? none,
		};
	}

	/** Its messages, the one that started it first. */
	get messages(): readonly InboundMessage[] {
		return this.#messages;
	}

	/** Adds a message steered into its turn. */
	add(message: InboundMessage): void {
		this.#messages.push(message);
	}

	/** Takes back a message its turn did not take after all. */
	remove(message: InboundMessage): void {
		const at = this.#messages.indexOf(message);
		if (at > 0) this.#messages.splice(at, 1);
		this.#answered.delete(message);
	}

	/** A turn or queue task under it starts. */
	begin(): void {
		if (this.#open === 0) this.#hooks.reopened();
		this.#open += 1;
	}

	/** The admission, or a turn or queue task under it, ended. */
	end(): void {
		this.#open -= 1;
		if (this.#open === 0) this.#hooks.closed();
	}

	/** Its messages no `ok` turn answered yet. */
	unanswered(): InboundMessage[] {
		return this.#messages.filter((message) => !this.#answered.has(message));
	}

	/** How many turns under it ended `ok` so far; `onLeave` takes it as the point a task was asked for. */
	get answers(): number {
		return this.#answers;
	}

	/** Whether its messages were left for the next process. */
	get left(): boolean {
		return this.#left;
	}

	/**
	 * Runs `task` when its messages are left, unless a turn under it ended `ok` after `since` (its
	 * `answers` when the work that asked began): such as removing an agent message kept for the next
	 * start, which the next process sends again when it answers the message anew. An agent message a
	 * turn sent before it answered belongs to that answer and stays.
	 */
	onLeave(task: () => Promise<void>, since = this.#answers): void {
		this.#onLeave.push({ task, since });
	}

	/**
	 * Marks its messages left for the next process at once, then runs what `onLeave` asked, each
	 * failure its own; the returned promise ends when they have.
	 */
	async leave(): Promise<void> {
		this.#left = true;
		const due = this.#onLeave
			.splice(0)
			.filter(({ since }) => since === this.#answers);
		await Promise.allSettled(due.map(({ task }) => task()));
	}

	/** The stopping host refused a turn under it before it ran. */
	refusedByHost(): void {
		this.#hooks.refused();
	}

	/** What a turn that ended under it gives its pipeline; an answer once its messages were left is stopped. */
	settle<R>(result: R): R | StoppedResult {
		if (!isTurnResult(result)) return result;
		if (this.#left) return stoppedByHost();
		if (result.ok) {
			this.#answers += 1;
			for (const message of this.#messages) this.#answered.add(message);
		} else if (!result.stopped && result.error.message === STOPPING)
			// The runtime refuses a turn asked for once the host stops with this failure.
			this.refusedByHost();
		return result;
	}
}

const STOPPING = new HostStoppingError().message;

type StoppedResult = { ok: false; error: AgentRunError; stopped: true };

const stoppedByHost = (): StoppedResult => ({
	ok: false,
	error: new AgentRunError(STOPPING),
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
 * The records of the admitted turns still running, or with a turn or queue task running under
 * them: the router runs each turn admission through `run`, and the host marks the ones the drain
 * limit finds with `cut`, to leave those that did not answer once the abort grace is over. A record
 * whose turn the runtime refused as the host stopped, before or after the drain limit, is cut as
 * well.
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
		const record: TurnRecord = new TurnRecord(message, {
			closed: () => this.#live.delete(record),
			reopened: () => this.#live.add(record),
			refused: () => this.#cut.push(record),
		});
		this.#live.add(record);
		this.#running.set(channel, record);
		// An admission that throws HostStoppingError is refused by the router itself, as a waiting one is.
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
