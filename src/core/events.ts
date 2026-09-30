import type { Logger } from "./log.ts";
import type { EventHandlers, EventSink } from "./plugin.ts";

/** One registered plugin's handlers. */
interface Registered {
	plugin: string;
	events: EventHandlers;
}

/**
 * Delivers the core's events to the plugins' handlers, in registration order. A handler runs
 * apart from the code that reported the event, and one that throws is logged with its plugin's
 * name and never stops the others. Nothing is delivered until the host has linked the handlers.
 */
export class EventBus {
	readonly #logger: Logger;
	#handlers: readonly Registered[] = [];

	constructor(logger: Logger) {
		this.#logger = logger;
	}

	/** Starts delivering to these handlers. */
	link(handlers: readonly Registered[]): void {
		this.#handlers = handlers;
	}

	/** Delivers one event and waits for every handler; used where the caller must not go on before. */
	async deliver<Name extends keyof EventHandlers>(
		name: Name,
		...args: Parameters<NonNullable<EventHandlers[Name]>>
	): Promise<void> {
		for (const { plugin, events } of this.#handlers) {
			const handler = events[name] as
				| ((...values: unknown[]) => Promise<void> | void)
				| undefined;
			if (!handler) continue;
			try {
				await handler.apply(events, args);
			} catch (error) {
				this.#logger.error(
					{ plugin, event: name, err: error },
					"event handler failed",
				);
			}
		}
	}

	/** What the core reports to; each call returns at once. */
	readonly sink: EventSink = {
		turnStarted: (turn) => void this.deliver("turnStarted", turn),
		turnEnded: (turn) => void this.deliver("turnEnded", turn),
		changed: () => void this.deliver("changed"),
	};
}
