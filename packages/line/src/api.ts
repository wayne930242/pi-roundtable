import { LineApiError, LineError } from "./errors.ts";
import { LINE_API, type TokenSource } from "./token.ts";

/** The host LINE serves message content from; every other call goes to {@link LINE_API}. */
const LINE_DATA_API = "https://api-data.line.me";

export interface LineApiOptions {
	tokens: TokenSource;
	fetch?: typeof fetch;
	baseUrl?: string;
	/** Where message content is fetched from; default `https://api-data.line.me`. */
	dataBaseUrl?: string;
	/** Per-request timeout in milliseconds; default 15 seconds. */
	timeoutMs?: number;
}

export interface RequestOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: string | Uint8Array;
	/** `"data"` calls the content host; default `"api"`. */
	host?: "api" | "data";
	/** Aborts the call; an aborted call rejects with the signal's reason, not with a wrapped error. */
	signal?: AbortSignal;
	/** Replaces the client's per-request timeout, which also bounds reading the body. */
	timeoutMs?: number;
}

/**
 * LINE's API with the channel access token on every call. A `401` makes the token source forget
 * the token and the call is repeated once with a new one; a second `401` is an error. The error
 * says the status and LINE's request id, never the response body.
 */
export class LineApi {
	readonly #tokens: TokenSource;
	readonly #fetch: typeof fetch;
	readonly #base: string;
	readonly #dataBase: string;
	readonly #timeoutMs: number;

	constructor(options: LineApiOptions) {
		this.#tokens = options.tokens;
		this.#fetch = options.fetch ?? fetch;
		this.#base = options.baseUrl ?? LINE_API;
		this.#dataBase = options.dataBaseUrl ?? LINE_DATA_API;
		this.#timeoutMs = options.timeoutMs ?? 15_000;
	}

	/** The response of a successful call; its body is the caller's to read. */
	async request(path: string, options: RequestOptions = {}): Promise<Response> {
		for (let attempt = 0; ; attempt++) {
			options.signal?.throwIfAborted();
			const token = await this.#tokens.token();
			let response: Response;
			const timeout = AbortSignal.timeout(options.timeoutMs ?? this.#timeoutMs);
			try {
				response = await this.#fetch(
					`${options.host === "data" ? this.#dataBase : this.#base}${path}`,
					{
						method: options.method ?? "GET",
						headers: { ...options.headers, authorization: `Bearer ${token}` },
						...(options.body === undefined ? {} : { body: options.body }),
						signal: options.signal
							? AbortSignal.any([options.signal, timeout])
							: timeout,
					},
				);
			} catch (error) {
				// The caller gave up: it hears its own reason, which the inbox worker knows how to read.
				if (options.signal?.aborted) throw options.signal.reason;
				throw new LineError(
					"api_unreachable",
					`line: ${path} did not answer (${this.#tokens.redact(
						error instanceof Error ? error.message : String(error),
					)})`,
				);
			}
			if (
				response.status === 401 &&
				attempt === 0 &&
				this.#tokens.reject(token)
			) {
				await response.body?.cancel().catch(() => undefined);
				continue;
			}
			if (!response.ok) {
				await response.body?.cancel().catch(() => undefined);
				throw new LineApiError(
					response.status,
					`http_${response.status}`,
					`line: ${options.method ?? "GET"} ${path} answered ${response.status}`,
					response.headers.get("x-line-request-id") ?? undefined,
				);
			}
			return response;
		}
	}

	async json(path: string, options?: RequestOptions): Promise<unknown> {
		return (await this.request(path, options)).json();
	}

	/** The bot's user id, which a webhook's `destination` must equal. */
	async botUserId(): Promise<string> {
		const info = (await this.json("/v2/bot/info")) as { userId?: unknown };
		if (typeof info?.userId !== "string" || info.userId === "")
			throw new LineError("bot_info_malformed", "line: bot info has no userId");
		return info.userId;
	}

	/** The name LINE shows for a group. */
	async groupName(groupId: string): Promise<string> {
		const summary = (await this.json(
			`/v2/bot/group/${encodeURIComponent(groupId)}/summary`,
		)) as { groupName?: unknown };
		if (typeof summary?.groupName !== "string")
			throw new LineError(
				"group_summary_malformed",
				"line: group summary has no name",
			);
		return summary.groupName;
	}
}
