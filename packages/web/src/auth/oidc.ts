import { createHmac, randomBytes } from "node:crypto";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import { oidcProvider } from "pi-roundtable/kit";
import type { Identified } from "../visitors.ts";
import type { Credential } from "./authenticator.ts";
import { allowedNext, routeOfNext } from "./next.ts";
import { oidcPage } from "./oidc-pages.ts";
import {
	discoverProvider,
	type ProviderMetadata,
	urlOf,
} from "./oidc-provider.ts";
import {
	cookieValue,
	INTERACTION_NEEDED,
	MAX_CLAIM_CHARS,
	MAX_NAME_CHARS,
	MAX_ROLE_CHARS,
	MAX_ROLES,
	MAX_SUBJECT_CHARS,
	needsSignIn,
	PENDING_MS,
	PROVIDER_TIMEOUT_MS,
	same,
	sha256,
	textClaim,
	VERIFIED_EVERY_MS,
	VERIFIED_PRUNE_AT,
} from "./oidc-support.ts";
import type { OidcLoginOptions, Pending, SignedIn } from "./oidc-types.ts";
import type { SessionActor } from "./sessions.ts";

export type { OidcLoginOptions, SignedIn };
export { discoverProvider, type ProviderMetadata };

/**
 * Sign-in with an OpenID Connect provider, and the app's session behind it.
 *
 * `login` sends the person to the provider with a state, a nonce and a PKCE challenge, kept in a
 * signed cookie that lives ten minutes and works once. `auth/callback` exchanges the code, checks
 * the id_token once (signature, issuer, audience, expiry, nonce), asks the host's `check`, and has
 * `IDENTITY` admit the person; only then is a session made, in `web_sessions`, and its random id
 * set in a cookie. Every later request is judged by that session and a fresh read of the tier;
 * the provider is not asked again unless `reauthHours` says so. Nothing here logs a token, a
 * claim, a code or a session id.
 */
export class OidcLogin {
	readonly #options: OidcLoginOptions;
	readonly #keys: JWTVerifyGetKey;
	/** The names of the cookies: `__Secure-` because the mount is never the root. */
	readonly #sessionCookie = "__Secure-rt_session";
	readonly #pendingCookie = "__Secure-rt_login";
	readonly #outCookie = "__Secure-rt_out";
	/** States already used, until they would have lapsed. */
	readonly #spent = new Map<string, number>();
	/** When each session was last reported to `onSessionVerified`, by session id. */
	readonly #verified = new Map<string, number>();

	constructor(options: OidcLoginOptions) {
		this.#options = options;
		this.#keys =
			options.keys ??
			createRemoteJWKSet(urlOf(options.metadata.jwksUri), {
				timeoutDuration: PROVIDER_TIMEOUT_MS,
			});
	}

	#now(): number {
		return (this.#options.now ?? Date.now)();
	}

	#sign(value: Pending): string {
		const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
		const mac = createHmac("sha256", this.#options.key)
			.update(payload)
			.digest("base64url");
		return `${payload}.${mac}`;
	}

	/** The pending sign-in the cookie holds, if it is ours, unaltered and not lapsed. */
	#pending(request: Request): Pending | undefined {
		const value = cookieValue(
			request.headers.get("cookie"),
			this.#pendingCookie,
		);
		const [payload, mac, extra] = (value ?? "").split(".");
		if (!payload || !mac || extra !== undefined) return undefined;
		const want = createHmac("sha256", this.#options.key)
			.update(payload)
			.digest();
		if (!same(want, Buffer.from(mac, "base64url"))) return undefined;
		try {
			const pending = JSON.parse(
				Buffer.from(payload, "base64url").toString("utf8"),
			) as Pending;
			return typeof pending.s === "string" &&
				typeof pending.n === "string" &&
				typeof pending.v === "string" &&
				typeof pending.e === "number" &&
				pending.e > this.#now()
				? pending
				: undefined;
		} catch {
			return undefined;
		}
	}

	#cookie(
		name: string,
		value: string,
		path: string,
		maxAge: number,
		lax = true,
	): string {
		return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=${lax ? "Lax" : "Strict"}`;
	}

	/** Cookie lines that clear the pending-login cookie. */
	#clearPending(): string {
		return this.#cookie(
			this.#pendingCookie,
			"",
			`${this.#options.mount}/auth/`,
			0,
		);
	}

	#redirect(to: string, cookies: string[]): Response {
		const headers = new Headers({ location: to, "cache-control": "no-store" });
		for (const cookie of cookies) headers.append("set-cookie", cookie);
		return new Response(null, { status: 303, headers });
	}

	#page(
		notice: "signed-out" | "failed" | "not-allowed",
		status: number,
		cookies: string[] = [],
	): Response {
		const { mount, title, presentation } = this.#options;
		const response = oidcPage(notice, mount, title, presentation, status);
		for (const cookie of cookies) response.headers.append("set-cookie", cookie);
		return response;
	}

	/** The paths below the mount this flow answers without a session; undefined for any other. */
	async open(request: Request, rest: string): Promise<Response | undefined> {
		const read = request.method === "GET" || request.method === "HEAD";
		switch (rest) {
			case "login":
				return read
					? this.#login(request)
					: new Response("Method not allowed", { status: 405 });
			case "auth/callback":
				return read
					? this.#callback(request)
					: new Response("Method not allowed", { status: 405 });
			case "auth/signed-out":
				return read
					? this.#page("signed-out", 200)
					: new Response("Method not allowed", { status: 405 });
			case "auth/logout":
				return request.method === "POST"
					? this.#logout(request)
					: new Response("Method not allowed", { status: 405 });
			default:
				return undefined;
		}
	}

	// ── Sign-in ──

	#login(request: Request): Response {
		const next = allowedNext(
			URL.parse(request.url)?.searchParams.get("next"),
			this.#options.surface,
		);
		// A person who just logged out is asked, not signed in again silently by a provider session that is still alive.
		const silent =
			cookieValue(request.headers.get("cookie"), this.#outCookie) === undefined;
		return this.#authorize(next, silent, []);
	}

	#authorize(
		next: string | undefined,
		silent: boolean,
		cookies: string[],
	): Response {
		const { settings, metadata, origin, mount } = this.#options;
		const pending: Pending = {
			s: randomBytes(32).toString("base64url"),
			n: randomBytes(32).toString("base64url"),
			v: randomBytes(48).toString("base64url"),
			...(next ? { x: next } : {}),
			i: silent,
			e: this.#now() + PENDING_MS,
		};
		const url = urlOf(metadata.authorizationEndpoint);
		const params = url.searchParams;
		params.set("response_type", "code");
		params.set("client_id", settings.clientId);
		params.set("redirect_uri", `${origin}${mount}/auth/callback`);
		params.set("scope", settings.scopes.join(" "));
		params.set("state", pending.s);
		params.set("nonce", pending.n);
		params.set("code_challenge", sha256(pending.v).toString("base64url"));
		params.set("code_challenge_method", "S256");
		if (silent) params.set("prompt", "none");
		return this.#redirect(url.href, [
			...cookies,
			this.#cookie(
				this.#pendingCookie,
				this.#sign(pending),
				`${mount}/auth/`,
				PENDING_MS / 1000,
			),
		]);
	}

	async #callback(request: Request): Promise<Response> {
		const { logger, mount } = this.#options;
		const clear = [this.#clearPending()];
		const params =
			URL.parse(request.url)?.searchParams ?? new URLSearchParams();
		const pending = this.#pending(request);
		const fail = (
			reason: string,
			notice: "failed" | "not-allowed" = "failed",
		) => {
			logger.warn({ reason }, "web-console: a sign-in did not complete");
			return this.#page(notice, notice === "failed" ? 400 : 403, clear);
		};
		if (!pending) return fail("no pending sign-in");
		const spent = this.#spent;
		for (const [state, until] of spent)
			if (until <= this.#now()) spent.delete(state);
		const state = params.get("state");
		if (!state || !same(Buffer.from(state), Buffer.from(pending.s)))
			return fail("state mismatch");
		if (spent.has(state)) return fail("state used twice");
		spent.set(state, pending.e);
		const error = params.get("error");
		if (error) {
			// A silent request the provider cannot answer alone becomes a normal sign-in, once.
			if (pending.i && INTERACTION_NEEDED.has(error))
				return this.#authorize(pending.x, false, clear);
			return fail("the provider refused the sign-in");
		}
		const code = params.get("code");
		if (!code || code.length > 4096) return fail("no code");
		let claims: Record<string, unknown>;
		try {
			claims = await this.#claims(code, pending);
		} catch (cause) {
			return fail(
				cause instanceof Error ? cause.message : "token not accepted",
			);
		}
		const { settings } = this.#options;
		try {
			if (settings.check && !settings.check(claims))
				return fail("the host's check refused the token", "not-allowed");
		} catch {
			return fail("the host's check failed", "not-allowed");
		}
		const actor = this.#actorOf(claims);
		if (!actor) return fail("the token names no usable subject");
		let identified: Identified;
		try {
			identified = await this.#options.identify(actor);
		} catch {
			return fail("identity failed");
		}
		if ("refusal" in identified)
			return fail("the access rules refuse this person", "not-allowed");
		const { principal } = identified.visitor;
		const kept: Record<string, unknown> = {};
		for (const name of settings.storeClaims) {
			const value = claims[name];
			if (
				value !== undefined &&
				JSON.stringify(value).length <= MAX_CLAIM_CHARS
			)
				kept[name] = value;
		}
		const stored: SessionActor =
			settings.storeClaims.length > 0 ? { ...actor, claims: kept } : actor;
		const made = await this.#options.sessions.create(stored, principal.id);
		// The sign-in replaces whatever session the browser held.
		const old = cookieValue(request.headers.get("cookie"), this.#sessionCookie);
		if (old) await this.#options.sessions.end(old).catch(() => undefined);
		try {
			await this.#options.onSignIn?.({
				principalId: principal.id,
				speakerId: identified.visitor.speakerId,
				provider: actor.provider,
				name: actor.name,
			});
		} catch (cause) {
			logger.warn({ err: cause }, "web-console: a sign-in hook failed");
		}
		const days = this.#options.settings.sessionDays;
		const next = pending.x ? routeOfNext(pending.x) : "";
		const base = `${mount}/`;
		return this.#redirect(
			this.#options.routing === "path"
				? `${base}${next}`
				: next
					? `${base}#/${next}`
					: base,
			[
				...clear,
				this.#cookie(this.#sessionCookie, made.token, base, days * 86400),
				// A later logout leaves its marker; a sign-in clears it.
				this.#cookie(this.#outCookie, "", base, 0),
			],
		);
	}

	/** Exchanges the code and checks the id_token; throws a short reason, never a token. */
	async #claims(
		code: string,
		pending: Pending,
	): Promise<Record<string, unknown>> {
		const { settings, metadata, origin, mount, clientSecret } = this.#options;
		const form = new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: `${origin}${mount}/auth/callback`,
			client_id: settings.clientId,
			code_verifier: pending.v,
		});
		if (clientSecret) form.set("client_secret", clientSecret);
		let idToken: unknown;
		try {
			const response = await (this.#options.fetch ?? fetch)(
				metadata.tokenEndpoint,
				{
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: form,
					signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
				},
			);
			if (!response.ok) throw new Error("the token endpoint refused the code");
			idToken = ((await response.json()) as { id_token?: unknown }).id_token;
		} catch (cause) {
			throw cause instanceof Error &&
				cause.message === "the token endpoint refused the code"
				? cause
				: new Error("the token endpoint could not be reached");
		}
		if (typeof idToken !== "string" || idToken.length > 16_384)
			throw new Error("the token response has no id_token");
		let payload: Record<string, unknown>;
		try {
			({ payload } = await jwtVerify(idToken, this.#keys, {
				issuer: settings.issuer,
				audience: settings.clientId,
				algorithms: ["RS256", "ES256"],
			}));
		} catch {
			throw new Error("the id_token was not accepted");
		}
		if (typeof payload.nonce !== "string" || payload.nonce !== pending.n)
			throw new Error("the id_token's nonce does not match");
		return payload;
	}

	/** The actor facts a verified token stands for, without the surface or `partial`: admission adds those. */
	#actorOf(claims: Record<string, unknown>): SessionActor | undefined {
		const { settings, surface } = this.#options;
		const subject = textClaim(claims[settings.subjectClaim], MAX_SUBJECT_CHARS);
		if (!subject) return undefined;
		const name =
			textClaim(
				settings.nameClaim
					? claims[settings.nameClaim]
					: (claims.name ?? claims.preferred_username),
				MAX_NAME_CHARS,
			) ??
			textClaim(claims.preferred_username, MAX_NAME_CHARS) ??
			subject.slice(0, MAX_NAME_CHARS);
		const given =
			settings.rolesClaim === false ? undefined : claims[settings.rolesClaim];
		const names = (
			Array.isArray(given) ? given : given === undefined ? [] : [given]
		)
			.map((role) => textClaim(role, MAX_ROLE_CHARS))
			.filter((role): role is string => role !== undefined)
			.slice(0, MAX_ROLES);
		return {
			provider: oidcProvider(settings.issuer),
			subject,
			name,
			...(names.length > 0
				? {
						roles: [...new Set(names)].map((role) => `${surface}:role:${role}`),
					}
				: {}),
		};
	}

	// ── The session ──

	/** The credential of a request: the session its cookie names, or why there is none. */
	readonly credential: Credential = async (request) => {
		const token = cookieValue(
			request.headers.get("cookie"),
			this.#sessionCookie,
		);
		if (!token) return needsSignIn("no session");
		const session = await this.#options.sessions.touch(token);
		if (!session) return needsSignIn("session ended");
		const { reauthHours } = this.#options.settings;
		if (
			reauthHours !== undefined &&
			this.#now() - session.verifiedAt.getTime() > reauthHours * 3_600_000
		)
			return needsSignIn("the provider is due to vouch again");
		const { claims: _kept, ...facts } = session.actor;
		return { admitted: true, actor: facts, session: session.id };
	};

	/**
	 * Reports that a request or an open socket proved this session live, so the host may count the
	 * person as present. At most once per session every few minutes; never waits for the hook and
	 * never throws: a hook that fails is logged.
	 */
	verified(session: string, principalId: string): void {
		const hook = this.#options.onSessionVerified;
		if (!hook) return;
		const now = this.#now();
		const last = this.#verified.get(session);
		if (last !== undefined && now - last < VERIFIED_EVERY_MS) return;
		if (this.#verified.size >= VERIFIED_PRUNE_AT)
			for (const [id, at] of this.#verified)
				if (now - at >= VERIFIED_EVERY_MS) this.#verified.delete(id);
		this.#verified.set(session, now);
		const failed = (cause: unknown) =>
			this.#options.logger.warn(
				{ err: cause },
				"web-console: the session-verified hook failed",
			);
		try {
			Promise.resolve(hook(principalId)).catch(failed);
		} catch (cause) {
			failed(cause);
		}
	}

	async #logout(request: Request): Promise<Response> {
		const { mount, origin, settings, metadata } = this.#options;
		if (request.headers.get("origin") !== origin)
			return new Response("Forbidden", {
				status: 403,
				headers: { "cache-control": "no-store" },
			});
		const token = cookieValue(
			request.headers.get("cookie"),
			this.#sessionCookie,
		);
		if (token) {
			const id = await this.#options.sessions.end(token).catch(() => undefined);
			if (id) {
				this.#verified.delete(id);
				this.#options.onEnded?.(id);
			}
		}
		const base = `${mount}/`;
		let to = `${mount}/auth/signed-out`;
		if (settings.endSession && metadata.endSessionEndpoint) {
			const url = urlOf(metadata.endSessionEndpoint);
			url.searchParams.set("client_id", settings.clientId);
			url.searchParams.set(
				"post_logout_redirect_uri",
				`${origin}${mount}/auth/signed-out`,
			);
			to = url.href;
		}
		return this.#redirect(to, [
			this.#cookie(this.#sessionCookie, "", base, 0),
			// Marks the next sign-in as a deliberate one: no silent round trip until it completes.
			this.#cookie(this.#outCookie, "1", base, 86400),
		]);
	}
}
