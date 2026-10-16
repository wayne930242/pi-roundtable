import { LineApiError, LineError } from "./errors.ts";
import type { SourceKind } from "./events.ts";
import { LINE_API, type TokenSource } from "./token.ts";

/** The host LINE serves message content from; every other call goes to {@link LINE_API}. */
const LINE_DATA_API = "https://api-data.line.me";

/** How a push ended, as far as the caller needs to act on it. */
export type PushOutcome =
	| { outcome: "sent"; duplicate: boolean; requestId: string | undefined }
	| {
			outcome: "failed";
			status: number;
			/** A short lower-case word: `http_<status>`, or the property LINE refused when it names one. */
			code: string;
			requestId: string | undefined;
			retryAfterMs?: number;
	  };

/**
 * The code to keep for a refused push. LINE names the property it refused in `details`; the ones a
 * sender can cause are named so the channel can say what to fix, everything else is the status.
 */
function refusalCode(status: number, detail: unknown): string {
	const details =
		typeof detail === "object" && detail !== null && "details" in detail
			? (detail as { details: unknown }).details
			: undefined;
	if (Array.isArray(details))
		for (const item of details) {
			const property =
				typeof item === "object" && item !== null && "property" in item
					? String((item as { property: unknown }).property)
					: "";
			if (/sender\.name/i.test(property)) return "sender_name_refused";
			if (/sender\.iconUrl/i.test(property)) return "sender_icon_refused";
		}
	return `http_${status}`;
}

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
		const response = await this.exchange(path, options);
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

	/**
	 * The response of a call whatever its status, for a caller that acts on the status itself. A
	 * `401` is repeated once with a new token first. The body is the caller's to read or cancel.
	 */
	async exchange(
		path: string,
		options: RequestOptions = {},
	): Promise<Response> {
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

	/**
	 * Pushes up to five message objects to a chat under a retry key. A `2xx` is `sent`; a `409` says
	 * LINE already accepted a request with this key, which is `sent` too. Any other status comes back
	 * as `failed` with the status, a code (LINE's own refusal of a sender is named) and, for a `429`
	 * or `5xx`, how long LINE asked to wait. A call that gets no answer rejects with `api_unreachable`.
	 * No part of LINE's answer is kept but those.
	 */
	async push(
		to: string,
		messages: readonly unknown[],
		retryKey: string,
		signal?: AbortSignal,
	): Promise<PushOutcome> {
		const response = await this.exchange("/v2/bot/message/push", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-line-retry-key": retryKey,
			},
			body: JSON.stringify({ to, messages }),
			...(signal ? { signal } : {}),
		});
		const requestId = response.headers.get("x-line-request-id") ?? undefined;
		if (response.ok || response.status === 409) {
			await response.body?.cancel().catch(() => undefined);
			return { outcome: "sent", duplicate: response.status === 409, requestId };
		}
		const detail = await response
			.text()
			.then((text) => JSON.parse(text.slice(0, 8192)) as unknown)
			.catch(() => undefined);
		const retryAfter = Number(response.headers.get("retry-after"));
		return {
			outcome: "failed",
			status: response.status,
			code: refusalCode(response.status, detail),
			requestId,
			...(Number.isFinite(retryAfter) && retryAfter > 0
				? { retryAfterMs: Math.min(retryAfter, 3600) * 1000 }
				: {}),
		};
	}

	/** Answers an event with its reply token; the token is single use and short lived. */
	async reply(
		replyToken: string,
		messages: readonly unknown[],
		call: Pick<RequestOptions, "signal" | "timeoutMs"> = {},
	): Promise<void> {
		await this.request("/v2/bot/message/reply", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ replyToken, messages }),
			...call,
		});
	}

	/** How many people a push to a chat reaches: the member count of a group or room, else one. */
	async recipients(
		kind: SourceKind,
		id: string,
		call: Pick<RequestOptions, "signal" | "timeoutMs"> = {},
	): Promise<number> {
		if (kind === "user") return 1;
		const found = (await this.json(
			`/v2/bot/${kind}/${encodeURIComponent(id)}/members/count`,
			call,
		)) as { count?: unknown };
		if (typeof found?.count !== "number" || !Number.isInteger(found.count))
			throw new LineError(
				"member_count_malformed",
				"line: the member count has no count",
			);
		return Math.max(1, found.count);
	}

	/** The monthly message limit of the plan, or undefined when the plan has none. */
	async messageQuota(): Promise<number | undefined> {
		const found = (await this.json("/v2/bot/message/quota")) as {
			type?: unknown;
			value?: unknown;
		};
		if (found?.type === "none") return undefined;
		if (found?.type !== "limited" || typeof found.value !== "number")
			throw new LineError("quota_malformed", "line: the quota is malformed");
		return found.value;
	}

	/** How many messages this month has used. */
	async messageConsumption(): Promise<number> {
		const found = (await this.json("/v2/bot/message/quota/consumption")) as {
			totalUsage?: unknown;
		};
		if (typeof found?.totalUsage !== "number")
			throw new LineError(
				"consumption_malformed",
				"line: the consumption has no totalUsage",
			);
		return found.totalUsage;
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
