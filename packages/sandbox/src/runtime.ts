import type { ChannelKey } from "pi-roundtable";
import type { SandboxSpeaker } from "./broker.ts";
import type { SandboxReply } from "./protocol.ts";
import {
	checkImageProtocol,
	type ResolvedSandboxRuntimeOptions,
	resolveSandboxRuntimeOptions,
	type SandboxRuntimeOptions,
} from "./runtime-options.ts";
import { runSandboxTurn, workspaceKey } from "./sandbox-turn.ts";

export type { SandboxRuntimeOptions } from "./runtime-options.ts";

/** What a caller knows about a turn beyond who spoke and what they said. */
export interface SandboxTurnContext {
	/** The message's guild; with `workspace: "server"` it picks the shared workspace. */
	space?: string;
}

/** Turns that may wait behind the running one in a server workspace. */
const DEFAULT_MAX_WAITING = 4;

interface ActiveTurn {
	controller: AbortController;
	/** Settles with the turn; rejects if it was stopped while waiting for its workspace. */
	done: Promise<SandboxReply>;
}

/** Coordinates channel admission, cancellation and reset state; each turn owns its resources. */
export class SandboxRuntime {
	readonly #options: ResolvedSandboxRuntimeOptions;
	/** Running and waiting turns, by channel: a channel has at most one. */
	readonly #active = new Map<ChannelKey, ActiveTurn>();
	/** Per workspace, settles when the last turn queued on it has ended or been cancelled. */
	readonly #tails = new Map<string, Promise<void>>();
	/** Per workspace, the turns running or waiting on it. */
	readonly #queued = new Map<string, number>();
	readonly #fresh = new Map<ChannelKey, number>();
	#closed = false;

	constructor(options: SandboxRuntimeOptions) {
		this.#options = resolveSandboxRuntimeOptions(options);
	}

	/**
	 * Stops startup when the worker image is older than an option needs; a plugin asks this
	 * before it claims a message. Options that any image serves skip the question.
	 */
	verifyImage(): Promise<void> {
		return checkImageProtocol(this.#options);
	}

	/**
	 * Runs one turn for `speaker`, the author the host admitted, with the principal they resolved
	 * to; host tools and the credential hook read it, and a turn without one is refused. Turns
	 * that share a workspace (the channels of one guild, with `workspace: "server"`) run one at a
	 * time in arrival order: the turn timeout starts when a turn begins running, and `stop` ends
	 * a waiting turn by rejecting its promise.
	 */
	async runTurn(
		channel: ChannelKey,
		speaker: SandboxSpeaker,
		text: string,
		context: SandboxTurnContext = {},
	): Promise<SandboxReply> {
		if (this.#closed || this.#active.has(channel))
			throw new Error("sandbox is stopped or channel is busy");
		if (typeof speaker.principalId !== "string" || !speaker.principalId)
			throw new Error(
				"a sandbox turn needs the principal its speaker was admitted as",
			);
		if (
			text.length > 32_000 ||
			speaker.id.length > 256 ||
			speaker.name.length > 256 ||
			speaker.principalId.length > 256
		)
			throw new Error("sandbox message too large");
		const controller = new AbortController();
		// Snapshot before broker startup yields, so a reset requested during any
		// part of this turn remains pending for the next turn.
		const resetGeneration = this.#fresh.get(channel) ?? 0;
		// The admitted speaker, as of this call; a caller may reuse its object while the turn waits.
		const admitted = {
			id: speaker.id,
			name: speaker.name,
			principalId: speaker.principalId,
		};
		const key = workspaceKey(this.#options, channel, context.space);
		// One turn runs and `maxWaiting` wait; a guest mentioning the bot in many channels or
		// threads must not stall the guild for the whole queue, so the rest is refused.
		const queued = this.#queued.get(key) ?? 0;
		if (
			this.#options.workspace === "server" &&
			queued > (this.#options.maxWaiting ?? DEFAULT_MAX_WAITING)
		)
			throw new Error("sandbox workspace is busy");
		this.#queued.set(key, queued + 1);
		const previous = this.#tails.get(key) ?? Promise.resolve();
		const done = (async (): Promise<SandboxReply> => {
			await waitFor(previous, controller.signal);
			const timer = setTimeout(
				() => controller.abort(),
				this.#options.turnTimeoutMs ?? 120_000,
			);
			try {
				return await runSandboxTurn(
					this.#options,
					{
						channel,
						space: context.space,
						speaker: admitted,
						text,
						reset: resetGeneration > 0,
						signal: controller.signal,
					},
					(reply) => {
						if (reply.ok && this.#fresh.get(channel) === resetGeneration)
							this.#fresh.delete(channel);
					},
				);
			} finally {
				clearTimeout(timer);
			}
		})().finally(() => {
			controller.abort();
			this.#active.delete(channel);
			const left = (this.#queued.get(key) ?? 1) - 1;
			if (left > 0) this.#queued.set(key, left);
			else this.#queued.delete(key);
		});
		// The next turn on this workspace starts after the one ahead of this has ended, even
		// when this one is cancelled before it began.
		const tail = Promise.allSettled([previous, done]).then(() => {
			if (this.#tails.get(key) === tail) this.#tails.delete(key);
		});
		this.#tails.set(key, tail);
		this.#active.set(channel, { controller, done });
		return done;
	}

	startFresh(channel: ChannelKey): void {
		this.#fresh.set(channel, (this.#fresh.get(channel) ?? 0) + 1);
	}
	/** Stops the channel's turn, running or waiting for its workspace; true when there was one. */
	stop(channel: ChannelKey): boolean {
		const active = this.#active.get(channel);
		active?.controller.abort();
		return active !== undefined;
	}
	/** The channels with a running turn or one waiting for its workspace. */
	busy(): ChannelKey[] {
		return [...this.#active.keys()];
	}
	async dispose(): Promise<void> {
		this.#closed = true;
		const active = [...this.#active.values()];
		for (const entry of active) entry.controller.abort();
		await Promise.allSettled(active.map((entry) => entry.done));
	}
}

/** Waits for `ahead`, or rejects as soon as the turn is stopped. */
async function waitFor(
	ahead: Promise<void>,
	signal: AbortSignal,
): Promise<void> {
	signal.throwIfAborted();
	let onAbort: (() => void) | undefined;
	try {
		await Promise.race([
			ahead,
			new Promise<never>((_resolve, reject) => {
				onAbort = () =>
					reject(
						new Error("sandbox turn stopped while waiting for its workspace"),
					);
				signal.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
	signal.throwIfAborted();
}
