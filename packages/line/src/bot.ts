import type { Logger } from "pi-roundtable";
import type { LineApi } from "./api.ts";
import { errorCode } from "./errors.ts";

/** A failed lookup is not repeated sooner than this, however many webhooks ask. */
const RETRY_MS = 30_000;

export interface BotIdentityOptions {
	api: LineApi;
	logger: Logger;
	now: () => Date;
}

/**
 * The bot's user id, which every webhook's `destination` must equal. It is read from LINE when the
 * host starts and again, at most every 30 seconds, while it is still unknown and a webhook asks.
 * Until it is known a webhook is vouched for by its signature alone: the channel secret is the
 * only thing that can produce one.
 */
export class BotIdentity {
	readonly #api: LineApi;
	readonly #logger: Logger;
	readonly #now: () => Date;
	#id: string | undefined;
	#inflight: Promise<void> | undefined;
	#lastTry = Number.NEGATIVE_INFINITY;

	constructor(options: BotIdentityOptions) {
		this.#api = options.api;
		this.#logger = options.logger;
		this.#now = options.now;
	}

	/** The id, or undefined while it is unknown; asking also starts a lookup when one is due. */
	current(): string | undefined {
		if (
			this.#id === undefined &&
			this.#now().getTime() - this.#lastTry >= RETRY_MS
		)
			void this.refresh();
		return this.#id;
	}

	/** Asks LINE; a failure is logged by its code and leaves the id unknown. Never rejects. */
	refresh(): Promise<void> {
		this.#inflight ??= this.#ask().finally(() => {
			this.#inflight = undefined;
		});
		return this.#inflight;
	}

	async #ask(): Promise<void> {
		this.#lastTry = this.#now().getTime();
		try {
			this.#id = await this.#api.botUserId();
			this.#logger.info("the LINE bot identity is known");
		} catch (error) {
			this.#logger.warn(
				{ code: errorCode(error) },
				"the LINE bot identity could not be read; webhooks are checked by signature alone until it can",
			);
		}
	}
}
