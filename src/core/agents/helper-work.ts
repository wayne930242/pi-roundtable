import type { QueuePort } from "../contract/channels.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import type { Logger } from "../log.ts";
import type { AgentTurnRunner } from "./agent-ports.ts";
import { isHelper } from "./agent-rules.ts";
import type { PgAgentStore } from "./agent-store.ts";
import { keysOf, scopeOf } from "./team-keys.ts";

export interface HelperWorkOptions {
	store: Pick<PgAgentStore, "agent" | "group" | "setFinished">;
	queue: Pick<QueuePort, "size">;
	runtime: () => Pick<AgentTurnRunner, "heldActions">;
	/** The surfaces that host rooms, which are places of a temp knight beside its Discord thread. */
	roomSurfaces: () => readonly string[];
	/** Called after a temp knight's state changed, so the pages and the dashboard redraw. */
	changed: () => void;
	logger: Logger;
}

/**
 * What keeps a temp knight working: a turn that runs, a message from its parent that has not been
 * answered, a turn or message queued in one of its places, or a held action that waits for the
 * owner. The moment none holds, the knight is *finished* and the store says so; any work that
 * begins makes it working again, so no one reopens it.
 */
export class HelperWork {
	readonly #options: HelperWorkOptions;
	/** Turns and unanswered messages of each temp knight. */
	readonly #running = new Map<string, number>();

	constructor(options: HelperWorkOptions) {
		this.#options = options;
	}

	/** A turn or a message to the agent begins; a finished temp knight is working again. */
	begin(name: string): void {
		if (!this.#helper(name)) return;
		this.#running.set(name, (this.#running.get(name) ?? 0) + 1);
		this.#stamp(name, false);
	}

	/** One piece of work of the agent ended; with nothing else holding it, a temp knight is finished. */
	end(name: string): void {
		const left = (this.#running.get(name) ?? 0) - 1;
		if (left > 0) {
			this.#running.set(name, left);
			return;
		}
		this.#running.delete(name);
		if (!this.#helper(name)) return;
		void this.#settle(name);
	}

	/** Whether the agent is an active temp knight. */
	#helper(name: string): boolean {
		const agent = this.#options.store.agent(name);
		return agent?.status === "active" && isHelper(agent);
	}

	async #settle(name: string): Promise<void> {
		try {
			if (await this.#waiting(name)) return;
			// Work begun while the held actions were read keeps it working.
			if ((this.#running.get(name) ?? 0) > 0) return;
			this.#stamp(name, true);
		} catch (error) {
			this.#options.logger.warn(
				{ agent: name, err: error },
				"temp knight's state not settled",
			);
		}
	}

	/** Whether something else waits: a turn queued behind this one, or an action held for the owner. */
	async #waiting(name: string): Promise<boolean> {
		const { store, queue, roomSurfaces } = this.#options;
		const agent = store.agent(name);
		if (!agent) return false;
		const keys: ChannelKey[] = keysOf(store, name, roomSurfaces());
		// The task that just ended still counts in its channel's queue until it returns.
		if (keys.some((key) => queue.size(key) > 1)) return true;
		const runtime = this.#options.runtime();
		for (const key of keys)
			if (await runtime.heldActions(scopeOf(agent, key).session)) return true;
		return false;
	}

	#stamp(name: string, finished: boolean): void {
		const { store, changed, logger } = this.#options;
		store.setFinished(name, finished).then(
			(moved) => {
				if (moved) changed();
			},
			(error: unknown) =>
				logger.warn(
					{ agent: name, err: error },
					"temp knight's state not kept",
				),
		);
	}
}
