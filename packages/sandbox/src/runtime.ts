import type { ChannelKey } from "pi-roundtable";
import type { SandboxSpeaker } from "./broker.ts";
import type { SandboxReply } from "./protocol.ts";
import {
	type ResolvedSandboxRuntimeOptions,
	resolveSandboxRuntimeOptions,
	type SandboxRuntimeOptions,
} from "./runtime-options.ts";
import { runSandboxTurn } from "./sandbox-turn.ts";

export type { SandboxRuntimeOptions } from "./runtime-options.ts";

/** Coordinates channel admission, cancellation and reset state; each turn owns its resources. */
export class SandboxRuntime {
	readonly #options: ResolvedSandboxRuntimeOptions;
	readonly #active = new Map<
		ChannelKey,
		{ controller: AbortController; done: Promise<SandboxReply> }
	>();
	readonly #fresh = new Map<ChannelKey, number>();
	#closed = false;

	constructor(options: SandboxRuntimeOptions) {
		this.#options = resolveSandboxRuntimeOptions(options);
	}

	/**
	 * Runs one turn for `speaker`, the author the host admitted, with the principal they resolved
	 * to; host tools and the credential hook read it, and a turn without one is refused.
	 */
	async runTurn(
		channel: ChannelKey,
		speaker: SandboxSpeaker,
		text: string,
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
		const timer = setTimeout(
			() => controller.abort(),
			this.#options.turnTimeoutMs ?? 120_000,
		);
		// Snapshot before broker startup yields, so a reset requested during any
		// part of this turn remains pending for the next turn.
		const resetGeneration = this.#fresh.get(channel) ?? 0;
		const done = runSandboxTurn(
			this.#options,
			{
				channel,
				speaker: {
					id: speaker.id,
					name: speaker.name,
					principalId: speaker.principalId,
				},
				text,
				reset: resetGeneration > 0,
				signal: controller.signal,
			},
			(reply) => {
				if (reply.ok && this.#fresh.get(channel) === resetGeneration)
					this.#fresh.delete(channel);
			},
		).finally(() => {
			controller.abort();
			clearTimeout(timer);
			this.#active.delete(channel);
		});
		this.#active.set(channel, { controller, done });
		return done;
	}

	startFresh(channel: ChannelKey): void {
		this.#fresh.set(channel, (this.#fresh.get(channel) ?? 0) + 1);
	}
	stop(channel: ChannelKey): boolean {
		const active = this.#active.get(channel);
		active?.controller.abort();
		return active !== undefined;
	}
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
