import type { SQL } from "bun";
import type { Logger } from "pi-roundtable";
import { errorCode, LineError } from "./errors.ts";
import { parseWebhook } from "./events.ts";
import { persistEvents } from "./intake.ts";
import type { TokenSource } from "./token.ts";

/** The most a webhook request body may hold: LINE sends far less, and anything near this is not LINE. */
export const WEBHOOK_MAX_BYTES = 1024 * 1024;

/** What the webhook has answered since the plugin was set up: counts and times only, never a body, address or signature. */
export interface WebhookHealth {
	/** Requests with a valid signature for this bot that were answered `200` (an empty Verify included). */
	accepted: number;
	/**
	 * Requests turned away: `signature` is a missing or wrong `x-line-signature`, `destination` is a
	 * signed webhook for another bot, `malformed` is a body that is too large or not a webhook.
	 */
	rejected: { signature: number; destination: number; malformed: number };
	/** When the last request was accepted, as an ISO time; left out until one was. */
	lastAcceptedAt?: string;
	/** When the last request was rejected, as an ISO time; left out until one was. */
	lastRejectedAt?: string;
}

/** The webhook's counters: each request adds to one of them and nothing else is kept. */
export class WebhookStats {
	#accepted = 0;
	#rejected = { signature: 0, destination: 0, malformed: 0 };
	#acceptedAt: string | undefined;
	#rejectedAt: string | undefined;

	accept(at: Date): void {
		this.#accepted++;
		this.#acceptedAt = at.toISOString();
	}

	reject(reason: keyof WebhookHealth["rejected"], at: Date): void {
		this.#rejected[reason]++;
		this.#rejectedAt = at.toISOString();
	}

	health(): WebhookHealth {
		return {
			accepted: this.#accepted,
			rejected: { ...this.#rejected },
			...(this.#acceptedAt ? { lastAcceptedAt: this.#acceptedAt } : {}),
			...(this.#rejectedAt ? { lastRejectedAt: this.#rejectedAt } : {}),
		};
	}
}

export interface WebhookOptions {
	sql: SQL;
	tokens: TokenSource;
	logger: Logger;
	now: () => Date;
	/** The bot's user id, once known; a webhook for another bot is refused. Unknown means the signature alone vouches. */
	botUserId: () => string | undefined;
	/** Called after events were stored, so the worker looks at the inbox now rather than at its next poll. */
	stored: () => void;
	/** Counts what the webhook answers; the plugin reads it for `LINE.health()`. */
	stats: WebhookStats;
	maxBytes?: number;
}

const reply = (status: number, text: string) =>
	new Response(text, { status, headers: { "cache-control": "no-store" } });

/**
 * Reads a body of at most `max` bytes; undefined when it is larger. The declared length is
 * checked first, and a body that lies about it is cut off as soon as it passes the limit.
 */
async function readCapped(
	request: Request,
	max: number,
): Promise<Uint8Array | undefined> {
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > max) return undefined;
	if (!request.body) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = request.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel().catch(() => undefined);
			return undefined;
		}
		chunks.push(value);
	}
	const body = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		body.set(chunk, at);
		at += chunk.byteLength;
	}
	return body;
}

/**
 * LINE's webhook: the raw body is verified against `x-line-signature` before anything is parsed,
 * every event is stored in one transaction, and only then does it answer `200`. A database that
 * is down answers `500`, which makes LINE's redelivery (if the channel has it on) resend.
 * An empty `events` array (LINE's Verify button) is a `200` that stores nothing. Each answer adds
 * to `options.stats`, which keeps counts and times only.
 */
export function webhookHandler(
	options: WebhookOptions,
): (request: Request) => Promise<Response> {
	const max = options.maxBytes ?? WEBHOOK_MAX_BYTES;
	const { stats } = options;
	return async (request) => {
		if (request.method !== "POST") return reply(405, "Method Not Allowed");
		const body = await readCapped(request, max);
		if (!body) {
			stats.reject("malformed", options.now());
			return reply(413, "Payload Too Large");
		}
		const signature = request.headers.get("x-line-signature");
		if (!signature || !options.tokens.verifies(body, signature)) {
			stats.reject("signature", options.now());
			options.logger.warn("a LINE webhook was refused: bad signature");
			return reply(401, "Unauthorized");
		}
		let parsed: Awaited<ReturnType<typeof parseWebhook>>;
		try {
			parsed = await parseWebhook(body);
		} catch (error) {
			if (!(error instanceof LineError)) throw error;
			stats.reject("malformed", options.now());
			options.logger.warn({ code: error.code }, "a LINE webhook was refused");
			return reply(400, "Bad Request");
		}
		const bot = options.botUserId();
		if (bot !== undefined && parsed.destination !== bot) {
			stats.reject("destination", options.now());
			options.logger.warn("a LINE webhook was refused: it is for another bot");
			return reply(403, "Forbidden");
		}
		if (parsed.events.length === 0) {
			stats.accept(options.now());
			return reply(200, "OK");
		}
		try {
			const result = await persistEvents(
				options.sql,
				parsed.events,
				options.now(),
			);
			options.logger.info(result, "LINE events stored");
			if (result.queued > 0) options.stored();
		} catch (error) {
			// The code only: the message could quote a column of the event being stored.
			options.logger.error(
				{ code: errorCode(error) },
				"LINE events could not be stored",
			);
			return reply(500, "Internal Server Error");
		}
		stats.accept(options.now());
		return reply(200, "OK");
	};
}
