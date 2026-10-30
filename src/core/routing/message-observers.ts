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

/**
 * Whether the filter lets the message through. A direct message passes only when the filter asks
 * for it, and a message of a surface that hosts private rooms only when the filter names that
 * surface.
 */
function matches(
	filter: Readonly<ObserveFilter>,
	message: InboundMessage,
	rooms: ReadonlySet<string>,
) {
	if (message.isDirect && filter.includeDirect !== true) return false;
	const { surface } = parseChannelKey(message.channel);
	if (filter.surface !== undefined && surface !== filter.surface) return false;
	if (filter.surface === undefined && rooms.has(surface)) return false;
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
	readonly #rooms: () => readonly string[];

	/**
	 * `rooms` names the surfaces that host private rooms (`agentRooms`); a filter that does not
	 * name the surface does not hear their messages. It is read for each message, since surfaces
	 * are linked after the observers are made.
	 */
	constructor(logger: Logger, rooms: () => readonly string[] = () => []) {
		this.#logger = logger;
		this.#rooms = rooms;
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
			// Anything that throws here, such as a value that cannot be cloned, is the observer's loss.
			try {
				if (!matches(filter, message, new Set(this.#rooms()))) continue;
				const copy = Object.freeze(structuredClone(message));
				void Promise.resolve()
					.then(() => observer(copy))
					.catch((error: unknown) => this.#failed(error));
			} catch (error) {
				this.#failed(error);
			}
		}
	}

	#failed(error: unknown): void {
		this.#logger.warn(
			{ error: error instanceof Error ? error.name : "unknown" },
			"a message observer failed",
		);
	}
}
