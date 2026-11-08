import { AsyncLocalStorage } from "node:async_hooks";
import type { ChannelKey } from "../domain/sessions.ts";
import { HostStoppingError } from "../kernel/errors.ts";

/** Runs tasks one at a time per channel, in arrival order; different channels run independently. */
export class ChannelQueue {
	readonly #tails = new Map<ChannelKey, Promise<unknown>>();
	readonly #sizes = new Map<ChannelKey, number>();
	readonly #listeners: ((channel: ChannelKey) => void)[] = [];
	/** Set inside `finishing`, so what a delivery starts and awaits sees the queue as open. */
	readonly #finishing = new AsyncLocalStorage<true>();
	#closed = false;
	#sealed = false;

	/** Called whenever a channel's count of running and waiting tasks changes. */
	onChange(listener: (channel: ChannelKey) => void): void {
		this.#listeners.push(listener);
	}

	#changed(channel: ChannelKey): void {
		for (const listener of this.#listeners) listener(channel);
	}

	/**
	 * Whether the host is shutting down, so no task starts any more; false for work inside
	 * `finishing` until the queue is sealed.
	 */
	get closed(): boolean {
		return this.#closed && !this.#admitted();
	}

	#admitted(): boolean {
		return !this.#sealed && this.#finishing.getStore() === true;
	}

	/**
	 * Starts the shutdown: from now on a task that has not started, whether queued before or after
	 * this call, is refused with HostStoppingError. A running task finishes.
	 */
	close(): void {
		this.#closed = true;
	}

	/**
	 * Ends the drain: from now on `finishing` admits nothing either. The host seals the queue once
	 * the drain has waited, before it stops the services.
	 */
	seal(): void {
		this.#closed = true;
		this.#sealed = true;
	}

	/**
	 * Runs `task` as the delivery of work the shutdown drain waits for, such as the report of a
	 * task that was running when the host began to stop. A queue task started inside it, and
	 * everything that task awaits, is admitted although the queue is closed, until the drain ends.
	 * Outside a shutdown it changes nothing.
	 */
	finishing<T>(task: () => Promise<T>): Promise<T> {
		return this.#finishing.run(true, task);
	}

	run<T>(channel: ChannelKey, task: () => Promise<T>): Promise<T> {
		const admitted = this.#admitted();
		const start = () =>
			this.#closed && !(admitted && !this.#sealed)
				? Promise.reject(new HostStoppingError())
				: task();
		this.#sizes.set(channel, this.size(channel) + 1);
		this.#changed(channel);
		const previous = this.#tails.get(channel) ?? Promise.resolve();
		const result = previous.then(start, start);
		const tail = result.catch(() => undefined);
		this.#tails.set(channel, tail);
		void tail.then(() => {
			const left = this.size(channel) - 1;
			if (left > 0) this.#sizes.set(channel, left);
			else this.#sizes.delete(channel);
			if (this.#tails.get(channel) === tail) this.#tails.delete(channel);
			this.#changed(channel);
		});
		return result;
	}

	/** Tasks of the channel running or waiting. */
	size(channel: ChannelKey): number {
		return this.#sizes.get(channel) ?? 0;
	}

	/** Channels with a task running or waiting. */
	busy(): ChannelKey[] {
		return [...this.#sizes.keys()];
	}
}

/** A queue of its own, apart from the host's; for work that must not wait behind a running turn. */
export function channelQueue(): ChannelQueue {
	return new ChannelQueue();
}
