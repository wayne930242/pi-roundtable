import { createHmac, timingSafeEqual } from "node:crypto";
import { scrubDiagnostic } from "pi-roundtable/kit";
import { errorCode, LineApiError, LineError } from "./errors.ts";

/** How the package gets the channel access token it calls LINE with. */
export type TokenMode = "stateless" | { static: string };

/** The channel's credentials. The secret also verifies every webhook signature. */
export interface LineCredentials {
	/** The channel id, a number written as a string. It is not secret. */
	channelId: string;
	channelSecret: string;
	/**
	 * `"stateless"` (the default) asks LINE for a token of about 15 minutes with the channel id and
	 * secret, and asks again when it lapses. `{ static: token }` uses a long-lived token a console
	 * issued; it cannot be reissued, so a `401` is then final.
	 */
	token?: TokenMode;
}

export const LINE_API = "https://api.line.me";
const TOKEN_PATH = "/oauth2/v3/token";
/** A token is replaced this long before LINE would refuse it. */
const EARLY_MS = 60_000;
/** The request timeout for the token endpoint. */
const ISSUE_TIMEOUT_MS = 15_000;

export interface TokenSourceOptions {
	credentials: LineCredentials;
	/** Replaces `fetch`, for tests. */
	fetch?: typeof fetch;
	/** The current time in milliseconds, for tests. */
	now?: () => number;
	baseUrl?: string;
}

/** One issue of a stateless token in progress; `quiet` until a caller other than a probe shares it. */
interface Flight {
	promise: Promise<Issued>;
	quiet: boolean;
}

interface Issued {
	token: string;
	/** Epoch milliseconds after which the token is replaced. */
	validUntil: number;
}

/**
 * Hands out the channel access token. It issues stateless tokens one at a time (concurrent callers
 * share one request), keeps a token in memory only until a minute before it lapses, and forgets
 * one LINE rejected. The token and the secret live in private fields: they are in no log, no error
 * message and no serialized form of this object. A failed issue is told, by its code, to the
 * listeners of {@link TokenSource.onFailure}.
 */
export class TokenSource {
	readonly #id: string;
	readonly #secret: string;
	readonly #static: string | undefined;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	readonly #base: string;
	#current: Issued | undefined;
	#inflight: Flight | undefined;
	#issued = 0;
	#lastFailure: string | undefined;
	readonly #listeners = new Set<(code: string) => void>();

	constructor(options: TokenSourceOptions) {
		const {
			channelId,
			channelSecret,
			token = "stateless",
		} = options.credentials;
		if (typeof channelId !== "string" || !/^[0-9]+$/.test(channelId))
			throw new LineError(
				"bad_credentials",
				"line: credentials.channelId must be the channel id, digits written as a string",
			);
		if (typeof channelSecret !== "string" || channelSecret.length === 0)
			throw new LineError(
				"bad_credentials",
				"line: credentials.channelSecret must be a non-empty string",
			);
		if (
			token !== "stateless" &&
			(typeof token !== "object" ||
				token === null ||
				typeof token.static !== "string" ||
				token.static.length === 0)
		)
			throw new LineError(
				"bad_credentials",
				'line: credentials.token must be "stateless" or { static: <token> }',
			);
		this.#id = channelId;
		this.#secret = channelSecret;
		this.#static = token === "stateless" ? undefined : token.static;
		this.#fetch = options.fetch ?? fetch;
		this.#now = options.now ?? Date.now;
		this.#base = options.baseUrl ?? LINE_API;
	}

	get channelId(): string {
		return this.#id;
	}

	/**
	 * Whether `signature` (the base64 `x-line-signature` header) is the HMAC-SHA256 of `body` under
	 * the channel secret, compared in constant time. The secret itself never leaves this object.
	 */
	verifies(body: Uint8Array, signature: string): boolean {
		const given = Buffer.from(signature, "base64");
		const expected = createHmac("sha256", this.#secret).update(body).digest();
		// A signature of another length is wrong; timingSafeEqual would throw on it.
		return given.length === expected.length && timingSafeEqual(given, expected);
	}

	/** How many stateless tokens were issued, and the last failure's code; neither holds a secret. */
	health(): { issued: number; lastFailure: string | undefined } {
		return { issued: this.#issued, lastFailure: this.#lastFailure };
	}

	/** A token that is valid now, issuing one when there is none. */
	async token(): Promise<string> {
		if (this.#static) return this.#static;
		const held = this.#current;
		if (held && held.validUntil > this.#now()) return held.token;
		return (await this.#join(false)).token;
	}

	/**
	 * Undefined when a token is held or can be issued now, else the code of the failure. An issue it
	 * starts is told to no listener, unless a caller of `token()` shares it meanwhile.
	 */
	async probe(): Promise<string | undefined> {
		if (this.#static) return undefined;
		const held = this.#current;
		if (held && held.validUntil > this.#now()) return undefined;
		try {
			await this.#join(true);
			return undefined;
		} catch (error) {
			return errorCode(error);
		}
	}

	/**
	 * Calls `listener` with the code of each failed issue (`token_refused`, `token_unreachable`,
	 * `token_malformed`), once per issue however many callers shared it. Returns the function that
	 * detaches it. A listener that throws, or returns a promise that rejects, is ignored.
	 */
	onFailure(listener: (code: string) => void): () => void {
		this.#listeners.add(listener);
		return () => void this.#listeners.delete(listener);
	}

	/** The issue in progress, started when there is none. A caller that is not a probe makes it audible. */
	#join(quiet: boolean): Promise<Issued> {
		if (this.#inflight) {
			if (!quiet) this.#inflight.quiet = false;
			return this.#inflight.promise;
		}
		const flight: Flight = {
			quiet,
			promise: this.#issue()
				.catch((error: unknown) => {
					if (!flight.quiet) this.#notify(errorCode(error));
					throw error;
				})
				.finally(() => {
					this.#inflight = undefined;
				}),
		};
		this.#inflight = flight;
		return flight.promise;
	}

	#notify(code: string): void {
		for (const listener of [...this.#listeners])
			try {
				// An async listener that rejects is as harmless as one that throws.
				void Promise.resolve(listener(code)).catch(() => undefined);
			} catch {
				// A listener must not throw; one that does costs the others nothing.
			}
	}

	/**
	 * Drops `rejected` when LINE refused it, so the next `token()` issues a new one. Returns whether
	 * a new token can come: a static token cannot be replaced.
	 */
	reject(rejected: string): boolean {
		if (this.#static) return false;
		if (this.#current?.token === rejected) this.#current = undefined;
		return true;
	}

	async #issue(): Promise<Issued> {
		let response: Response;
		try {
			response = await this.#fetch(`${this.#base}${TOKEN_PATH}`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "client_credentials",
					client_id: this.#id,
					client_secret: this.#secret,
				}),
				signal: AbortSignal.timeout(ISSUE_TIMEOUT_MS),
			});
		} catch (error) {
			this.#lastFailure = "token_unreachable";
			throw new LineError(
				"token_unreachable",
				`line: the token endpoint did not answer (${this.redact(error instanceof Error ? error.message : String(error))})`,
			);
		}
		if (!response.ok) {
			this.#lastFailure = "token_refused";
			// The body is not read into the message: an endpoint may echo what it was sent.
			await response.body?.cancel().catch(() => undefined);
			throw new LineApiError(
				response.status,
				"token_refused",
				`line: the token endpoint answered ${response.status}`,
				response.headers.get("x-line-request-id") ?? undefined,
			);
		}
		const body = (await response.json().catch(() => undefined)) as
			| { access_token?: unknown; expires_in?: unknown }
			| undefined;
		const token = body?.access_token;
		const lifetime = Number(body?.expires_in);
		if (typeof token !== "string" || token === "" || !(lifetime > 0)) {
			this.#lastFailure = "token_malformed";
			throw new LineError(
				"token_malformed",
				"line: the token endpoint answered without a usable access token",
			);
		}
		this.#issued++;
		this.#lastFailure = undefined;
		const lifeMs = lifetime * 1000;
		// A very short token still lives for half its life instead of being refused at once.
		const margin = Math.min(EARLY_MS, lifeMs / 2);
		const issued = { token, validUntil: this.#now() + lifeMs - margin };
		this.#current = issued;
		return issued;
	}

	/** Text safe to show: credentials are masked and the length is bounded, whatever a failing call quoted. */
	redact(message: string, max = 200): string {
		let text = scrubDiagnostic(message, max);
		for (const secret of [this.#secret, this.#current?.token, this.#static])
			if (secret)
				// A form body spells the secret percent-encoded, a header or URL may spell it either way.
				for (const spelling of new Set([
					secret,
					encodeURIComponent(secret),
					new URLSearchParams({ s: secret }).toString().slice(2),
				]))
					text = text.split(spelling).join("[redacted]");
		return text;
	}

	toJSON(): { channelId: string; token: string } {
		return {
			channelId: this.#id,
			token: this.#static ? "static" : "stateless",
		};
	}

	[Symbol.for("nodejs.util.inspect.custom")](): string {
		return `TokenSource(${this.#id}, ${this.#static ? "static" : "stateless"})`;
	}
}
