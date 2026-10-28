import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ActorFacts, Logger } from "pi-roundtable";
import { PluginError } from "pi-roundtable";
import { type ConsolePresentation, message } from "../features.ts";
import { MIN_PASSWORD_LENGTH } from "../options.ts";
import { readLimited } from "../request-body.ts";
import { LOGIN_CSP, loginPage } from "./login-page.ts";

/** The session cookie's name. */
export const SESSION_COOKIE = "rt_session";
/** How many failed logins in the window lock the login page. */
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;
/** A login form is a password; anything bigger is not one. */
const MAX_BODY_BYTES = 4096;

export interface PasswordOptions {
	/** The secret, already read from the environment and checked. */
	password: string;
	/** The session key from the data directory. */
	key: Buffer;
	/** Who a session speaks for: the plugin identity's subject and name. */
	actor: ActorFacts;
	mount: string;
	origin: string;
	sessionDays: number;
	title: string;
	presentation: ConsolePresentation | undefined;
	logger: Logger;
	/** How long each failed login waits before answering; default 1000. */
	loginDelayMs: number;
	now: () => number;
}

/** A valid session: when it ends. */
export type SessionCheck =
	| { valid: true; expiresAt: Date }
	| { valid: false; reason: string };

const sha256 = (value: string | Buffer) =>
	createHash("sha256").update(value).digest();

const sign = (key: Buffer, payload: string) =>
	createHmac("sha256", key).update(payload).digest();

/** Whether two buffers are the same, in time that does not depend on where they differ. */
const same = (a: Buffer, b: Buffer) =>
	a.length === b.length && timingSafeEqual(a, b);

/** Whether a cookie part is the one base64url spelling of its bytes; unused trailing bits would let several spellings pass. */
const canonical = (part: string) =>
	Buffer.from(part, "base64url").toString("base64url") === part;

/** Checks the secret's length and returns it; the message never holds it. */
export function checkPassword(
	env: Readonly<Record<string, string | undefined>>,
	name: string,
): string {
	const value = env[name];
	if (value === undefined || value === "")
		throw new PluginError(
			`pi-roundtable-web: auth password reads the password from the environment variable ${name}, which is not set. Set it to a secret of at least ${MIN_PASSWORD_LENGTH} characters`,
		);
	if (Array.from(value).length < MIN_PASSWORD_LENGTH)
		throw new PluginError(
			`pi-roundtable-web: the password in ${name} is shorter than ${MIN_PASSWORD_LENGTH} characters; use at least ${MIN_PASSWORD_LENGTH}`,
		);
	return value;
}

const cookieValue = (
	header: string | null,
	name: string,
): string | undefined => {
	for (const part of (header ?? "").split(";")) {
		const at = part.indexOf("=");
		if (at > 0 && part.slice(0, at).trim() === name)
			return part.slice(at + 1).trim();
	}
	return undefined;
};

/** The body of a login form, or undefined when it is larger than a password can be. */
async function readForm(
	request: Request,
): Promise<URLSearchParams | undefined> {
	const raw = await readLimited(request, MAX_BODY_BYTES);
	return raw && new URLSearchParams(raw.toString("utf8"));
}

/**
 * The password credential: a login page, a signed session cookie, a global rate limit.
 *
 * The cookie is `b64url({p, e, v: 1}).b64url(HMAC-SHA256)`. Its key is the HMAC of the session key
 * over the password's digest, so a new password logs everyone out, and the session key alone
 * (a file in the data directory) signs nothing a host with another password would accept.
 */
export class PasswordCredential {
	readonly #options: PasswordOptions;
	readonly #secret: Buffer;
	readonly #signing: Buffer;
	readonly #failures: number[] = [];
	readonly #secure: boolean;
	readonly #path: string;

	constructor(options: PasswordOptions) {
		this.#options = options;
		this.#secret = sha256(options.password);
		this.#signing = sign(options.key, this.#secret.toString("base64url"));
		this.#secure = options.origin.startsWith("https:");
		this.#path = `${options.mount}/`;
	}

	/** Whether the request carries a session this host made and that has not ended. */
	check(request: Request): SessionCheck {
		const value = cookieValue(request.headers.get("cookie"), SESSION_COOKIE);
		if (!value) return { valid: false, reason: "no session" };
		const parts = value.split(".");
		const [payload, signature] = parts;
		if (
			parts.length !== 2 ||
			!payload ||
			!signature ||
			!canonical(payload) ||
			!canonical(signature)
		)
			return { valid: false, reason: "malformed session" };
		if (
			!same(sign(this.#signing, payload), Buffer.from(signature, "base64url"))
		)
			return { valid: false, reason: "invalid session" };
		let claims: { p?: unknown; e?: unknown; v?: unknown };
		try {
			claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		} catch {
			return { valid: false, reason: "invalid session" };
		}
		if (
			claims.v !== 1 ||
			claims.p !== this.#options.actor.subject ||
			typeof claims.e !== "number"
		)
			return { valid: false, reason: "invalid session" };
		if (claims.e * 1000 <= this.#options.now())
			return { valid: false, reason: "session ended" };
		return { valid: true, expiresAt: new Date(claims.e * 1000) };
	}

	/**
	 * The routes that need no session below the mount: the login page, `auth/login` and
	 * `auth/logout`. Undefined for any other path.
	 */
	async open(request: Request, rest: string): Promise<Response | undefined> {
		if (rest === "login")
			return request.method === "GET" || request.method === "HEAD"
				? this.#page(200)
				: new Response("Method not allowed", { status: 405 });
		if (rest !== "auth/login" && rest !== "auth/logout") return undefined;
		if (request.method !== "POST")
			return new Response("Method not allowed", { status: 405 });
		if (request.headers.get("origin") !== this.#options.origin)
			return new Response("Forbidden", {
				status: 403,
				headers: { "cache-control": "no-store" },
			});
		return rest === "auth/login" ? this.#login(request) : this.#logout();
	}

	#page(
		status: number,
		note?: string,
		headers: Record<string, string> = {},
	): Response {
		const { mount, title, presentation } = this.#options;
		return new Response(loginPage(mount, title, presentation, note), {
			status,
			headers: {
				"content-type": "text/html;charset=utf-8",
				"cache-control": "no-store",
				"content-security-policy": LOGIN_CSP,
				...headers,
			},
		});
	}

	#redirect(to: string, cookie: string): Response {
		return new Response(null, {
			status: 303,
			headers: {
				location: to,
				"set-cookie": cookie,
				"cache-control": "no-store",
			},
		});
	}

	#cookie(value: string, maxAge: number): string {
		return `${SESSION_COOKIE}=${value}; Path=${this.#path}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${this.#secure ? "; Secure" : ""}`;
	}

	/** Seconds until the login page opens again, or 0 when it is open. */
	#lockedFor(): number {
		const cutoff = this.#options.now() - WINDOW_MS;
		while (this.#failures.length > 0 && (this.#failures[0] ?? 0) <= cutoff)
			this.#failures.shift();
		if (this.#failures.length < MAX_FAILURES) return 0;
		return Math.max(
			1,
			Math.ceil(
				((this.#failures[0] ?? 0) + WINDOW_MS - this.#options.now()) / 1000,
			),
		);
	}

	async #login(request: Request): Promise<Response> {
		const { logger, presentation } = this.#options;
		const form = await readForm(request);
		if (!form) return new Response("Payload too large", { status: 413 });
		const retry = this.#lockedFor();
		if (retry > 0) {
			logger.warn({ retryAfter: retry }, "web-console: login is locked");
			return this.#page(
				429,
				message(presentation, "Too many failed attempts. Try again later."),
				{ "retry-after": String(retry) },
			);
		}
		const given = form.get("password") ?? "";
		if (!same(sha256(given), this.#secret)) {
			// Counted before the wait, so a burst of attempts at once cannot get past the limit.
			this.#failures.push(this.#options.now());
			logger.warn("web-console: a login failed");
			if (this.#options.loginDelayMs > 0)
				await Bun.sleep(this.#options.loginDelayMs);
			return this.#page(401, message(presentation, "Wrong password."));
		}
		const { sessionDays, actor } = this.#options;
		const expires =
			Math.floor(this.#options.now() / 1000) + sessionDays * 86400;
		const payload = Buffer.from(
			JSON.stringify({ p: actor.subject, e: expires, v: 1 }),
		).toString("base64url");
		const value = `${payload}.${sign(this.#signing, payload).toString("base64url")}`;
		return this.#redirect(this.#path, this.#cookie(value, sessionDays * 86400));
	}

	#logout(): Response {
		return this.#redirect(`${this.#options.mount}/login`, this.#cookie("", 0));
	}
}
