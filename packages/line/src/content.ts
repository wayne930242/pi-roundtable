import type { SQL } from "bun";
import type { LineApi } from "./api.ts";
import { LineApiError, LineError } from "./errors.ts";

export interface MediaOptions {
	/** The most bytes of one message's content held in memory; default 10 MiB. Past it the result is `{ tooLarge }`. */
	maxBytes: number;
	/** How long to wait between looks at a video or audio that LINE is still transcoding; default 2 seconds. */
	transcodingPollMs: number;
	/**
	 * How long to wait for it altogether, requests included; default 60 seconds. Past it the call
	 * fails with `transcoding_timeout`.
	 */
	transcodingMaxMs: number;
}

export const MEDIA_DEFAULTS: MediaOptions = {
	maxBytes: 10 * 1024 * 1024,
	transcodingPollMs: 2_000,
	transcodingMaxMs: 60_000,
};

/** What the content of a message can be, or why it cannot. */
export type LineContentResult =
	| { bytes: Uint8Array; contentType: string }
	/** The content is bigger than `media.maxBytes`; none of it is kept. */
	| { tooLarge: true }
	/** LINE no longer has it (it expires), the message was unsent, or LINE could not transcode it. */
	| { expired: true; reason: "expired" | "unsent" | "transcoding_failed" };

export interface LineContentRequest {
	/**
	 * The message's kind, as the `message` event gave it. A `"video"` or `"audio"` is waited for until
	 * LINE has transcoded it; without a kind the content is fetched at once.
	 */
	kind?: "image" | "video" | "audio" | "file";
	signal?: AbortSignal;
}

/** The longest a download of content may take, body included. */
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** The longest one look at the transcoding status may take, when the wait has more time than that left. */
const STATUS_TIMEOUT_MS = 15_000;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** LINE answers 404 (and 410) for content it no longer holds or never had. */
function isGone(error: unknown): boolean {
	return (
		error instanceof LineApiError &&
		(error.status === 404 || error.status === 410)
	);
}

/**
 * Fetches the content of a message into memory. Nothing is written to disk or to a log, and no URL
 * is made public: the bytes go to the caller and nowhere else. A message that was unsent is not
 * fetched at all.
 */
export class MessageContent {
	readonly #sql: SQL;
	readonly #api: LineApi;
	readonly options: MediaOptions;

	constructor(sql: SQL, api: LineApi, options: Partial<MediaOptions> = {}) {
		this.#sql = sql;
		this.#api = api;
		this.options = { ...MEDIA_DEFAULTS, ...options };
	}

	async fetch(
		messageId: string,
		request: LineContentRequest = {},
	): Promise<LineContentResult> {
		if (!MESSAGE_ID.test(messageId))
			throw new LineError(
				"bad_message_id",
				"line: a message id is up to 64 letters, digits, - and _",
			);
		const { signal } = request;
		const unsent = await this
			.#sql`SELECT 1 FROM line_tombstones WHERE message_id = ${messageId} LIMIT 1`;
		if (unsent.length > 0) return { expired: true, reason: "unsent" };
		const path = `/v2/bot/message/${messageId}/content`;
		if (request.kind === "video" || request.kind === "audio") {
			const state = await this.#transcoded(path, signal);
			if (state) return state;
		}
		let response: Response;
		try {
			response = await this.#api.request(path, {
				host: "data",
				timeoutMs: DOWNLOAD_TIMEOUT_MS,
				...(signal ? { signal } : {}),
			});
		} catch (error) {
			if (isGone(error)) return { expired: true, reason: "expired" };
			throw error;
		}
		return this.#read(response, signal);
	}

	/** Waits until LINE has transcoded a video or audio; undefined when it is ready, else the result to answer. */
	async #transcoded(
		path: string,
		signal: AbortSignal | undefined,
	): Promise<LineContentResult | undefined> {
		const deadline = Date.now() + this.options.transcodingMaxMs;
		for (let first = true; ; first = false) {
			const remaining = deadline - Date.now();
			// At least one look, however short the wait is.
			if (remaining <= 0 && !first) break;
			let status: unknown;
			try {
				const body = (await this.#api.json(`${path}/transcoding`, {
					host: "data",
					// A slow answer cannot outlast the wait: each request gets what is left of it.
					timeoutMs: Math.max(1, Math.min(remaining, STATUS_TIMEOUT_MS)),
					...(signal ? { signal } : {}),
				})) as { status?: unknown };
				status = body?.status;
			} catch (error) {
				if (isGone(error)) return { expired: true, reason: "expired" };
				if (
					error instanceof LineError &&
					error.code === "api_unreachable" &&
					remaining <= STATUS_TIMEOUT_MS
				)
					break;
				throw error;
			}
			if (status === "succeeded") return undefined;
			if (status === "failed")
				return { expired: true, reason: "transcoding_failed" };
			await sleep(
				Math.max(
					0,
					Math.min(this.options.transcodingPollMs, deadline - Date.now()),
				),
				signal,
			);
		}
		throw new LineError(
			"transcoding_timeout",
			"line: LINE did not finish transcoding the content in time",
		);
	}

	/** Reads the body up to the cap; past it nothing is kept. */
	async #read(
		response: Response,
		signal: AbortSignal | undefined,
	): Promise<LineContentResult> {
		const max = this.options.maxBytes;
		const declared = Number(response.headers.get("content-length"));
		if (declared > max) {
			await response.body?.cancel().catch(() => undefined);
			return { tooLarge: true };
		}
		const contentType =
			response.headers
				.get("content-type")
				?.split(";")[0]
				?.trim()
				.toLowerCase() || "application/octet-stream";
		const reader = response.body?.getReader();
		if (!reader) return { bytes: new Uint8Array(0), contentType };
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.byteLength;
				if (total > max) {
					await reader.cancel().catch(() => undefined);
					return { tooLarge: true };
				}
				chunks.push(value);
			}
		} catch {
			if (signal?.aborted) throw signal.reason;
			throw new LineError(
				"content_interrupted",
				"line: the content download was cut short",
			);
		}
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return { bytes, contentType };
	}
}
