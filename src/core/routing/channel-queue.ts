import type { ChannelKey } from "../sessions.ts";

/** Runs tasks one at a time per channel, in arrival order; different channels run independently. */
export class ChannelQueue {
	readonly #tails = new Map<ChannelKey, Promise<unknown>>();
	readonly #sizes = new Map<ChannelKey, number>();
	readonly #listeners: ((channel: ChannelKey) => void)[] = [];

	/** Called whenever a channel's count of running and waiting tasks changes. */
	onChange(listener: (channel: ChannelKey) => void): void {
		this.#listeners.push(listener);
	}

	#changed(channel: ChannelKey): void {
		for (const listener of this.#listeners) listener(channel);
	}

	run<T>(channel: ChannelKey, task: () => Promise<T>): Promise<T> {
		this.#sizes.set(channel, this.size(channel) + 1);
		this.#changed(channel);
		const previous = this.#tails.get(channel) ?? Promise.resolve();
		const result = previous.then(task, task);
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
