import type {
	InboundMessage,
	MessageObserver,
	ObserveFilter,
} from "../contract/channels.ts";
import { parseChannelKey } from "../contract/surface.ts";
import type { Logger } from "../log.ts";

interface Registered {
	filter: Readonly<ObserveFilter>;
	observer: MessageObserver;
}

/** Whether the filter lets the message through; a direct message only when the filter asks for it. */
function matches(filter: Readonly<ObserveFilter>, message: InboundMessage) {
	if (message.isDirect && filter.includeDirect !== true) return false;
	if (
		filter.surface !== undefined &&
		parseChannelKey(message.channel).surface !== filter.surface
	)
		return false;
	if (filter.space !== undefined && message.space !== filter.space)
		return false;
	if (filter.channels && !filter.channels.includes(message.channel))
		return false;
	return true;
}

/**
 * The plugins' passive listeners on inbound messages. `notify` hands each matching observer its
 * own frozen copy on a later tick and returns at once, so an observer cannot hold up, change or
 * fail the routing of the message it hears; its errors are logged by name, never with the text.
 */
export class MessageObservers {
	readonly #logger: Logger;
	readonly #observers = new Set<Registered>();

	constructor(logger: Logger) {
		this.#logger = logger;
	}

	/** Registers an observer; the returned function removes it. */
	add(filter: ObserveFilter, observer: MessageObserver): () => void {
		const entry = { filter: { ...filter }, observer };
		this.#observers.add(entry);
		return () => {
			this.#observers.delete(entry);
		};
	}

	/** Hands the message to every observer whose filter matches; never throws. */
	notify(message: InboundMessage): void {
		for (const { filter, observer } of this.#observers) {
			if (!matches(filter, message)) continue;
			const copy = Object.freeze(structuredClone(message));
			void Promise.resolve()
				.then(() => observer(copy))
				.catch((error: unknown) =>
					this.#logger.warn(
						{ error: error instanceof Error ? error.name : "unknown" },
						"a message observer failed",
					),
				);
		}
	}
}
