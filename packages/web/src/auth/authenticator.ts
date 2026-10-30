import type { ActorFacts, ListenerAddress, Logger } from "pi-roundtable";
import type { ConsolePresentation } from "../features.ts";
import type { ResolvedAuth } from "../options.ts";
import type { Verdict } from "../verifier.ts";
import type { Identified, Visitor } from "../visitors.ts";
import { checkNoneListener } from "./none.ts";
import type { OidcLogin } from "./oidc.ts";
import { checkPassword, PasswordCredential } from "./password.ts";
import { loadSessionKey } from "./session-key.ts";
import type { WebSessions } from "./sessions.ts";

/** The plugin identity `none` and `password` speak through; `RoundtablePlugin.identities` links it to the owner. */
export const WEB_CONSOLE_IDENTITY = "token:web-console";

/** The actor a request of mode `none` or `password` comes from. */
export const WEB_CONSOLE_ACTOR: ActorFacts = {
	provider: "token",
	subject: "web-console",
	name: "Web console",
};

/** A request that may go on: who it comes from, and when that lapses, when the credential says. */
export interface Authenticated {
	visitor: Visitor;
	actor?: ActorFacts;
	expiresAt?: Date;
	/** The session the credential is, when it is one: what an open socket asks about again. */
	session?: string;
}

/** What a socket holds of the credential it came in on, to ask again whether it still stands. */
export interface Held {
	actor: ActorFacts | undefined;
	session?: string | undefined;
}

/** A request that may not, with the status that says so; `login` when signing in would help. */
export interface Unauthenticated {
	/** Why, for the operator's log. It is never sent to the client, and it must not hold a secret. */
	refusal: string;
	status: 401 | 403;
	login?: true;
}

/**
 * The one check every request to the console passes, whatever carries it: a page, the API, the
 * event stream, and the WebSocket upgrade. It never throws.
 */
export interface Authenticator {
	authenticate(request: Request): Promise<Authenticated | Unauthenticated>;
	/**
	 * Asks again about a credential already admitted, as an open socket does for every frame and on
	 * a timer: does the session still stand, and who is the person now, at which tier. It reads the
	 * same `IDENTITY` as a request does, so a person disabled or demoted since is seen at once.
	 */
	recheck(held: Held): Promise<{ visitor: Visitor } | Unauthenticated>;
	/**
	 * Answers the paths below the mount that need no session, such as the login page; undefined
	 * for any other, and absent for a mode with none.
	 */
	open?(request: Request, rest: string): Promise<Response | undefined>;
}

export interface AuthenticatorOptions {
	auth: ResolvedAuth;
	/** Who an actor the credential vouched for is; only an owner is a visitor. */
	identify(actor: ActorFacts | undefined): Promise<Identified>;
	/** The console's own origin; requests that change data must come from it. */
	origin: string;
	/** The path the console is served under, without a trailing slash. */
	mount: string;
	title: string;
	presentation?: ConsolePresentation | undefined;
	logger: Logger;
	/** The host's data directory, whose `web/` holds the session key. */
	dataDir: string;
	/** The listener the console is served on and its address, for the check of `none`. */
	listener: { id: string; address: Readonly<ListenerAddress> | undefined };
	/** The sign-in flow and the session store, for `oidc`. */
	oidc?: {
		login: Pick<OidcLogin, "open" | "credential" | "verified">;
		sessions: Pick<WebSessions, "alive">;
	};
	/** Where the password is read from; default `process.env`. */
	env?: Readonly<Record<string, string | undefined>>;
	/** How long each failed login waits; default 1000 ms. Tests set it lower. */
	loginDelayMs?: number;
	/** The clock, in milliseconds; default `Date.now`. Tests set it. */
	now?: () => number;
}

/** A credential that admits: who it vouches for, and the session it is when it is one. */
export type Admitted = Extract<Verdict, { admitted: true }> & {
	session?: string;
};

/** What a credential says about a request, before the person is identified. */
export type Credential = (
	request: Request,
) => Promise<Verdict | Admitted | Unauthenticated>;

const READ_METHODS = new Set(["GET", "HEAD"]);

const denied = (refusal: string): Unauthenticated => ({
	refusal,
	status: 403,
});

/** A refusal in the shape identification answers with. */
const refused = (reason: string): Identified => ({ refusal: reason });

/** A session that is gone, which signing in again would fix. */
const signedOut = (reason: string): Unauthenticated => ({
	refusal: reason,
	status: 401,
	login: true,
});

/** Admits as the verifier says; one that throws or rejects admits no one. */
function verifierCredential(
	verifier: (request: Request) => Verdict | Promise<Verdict>,
): Credential {
	return async (request) => {
		try {
			const verdict = await verifier(request);
			return verdict.admitted ? verdict : denied(String(verdict.reason));
		} catch {
			return denied("verifier failed");
		}
	};
}

/**
 * Builds the authenticator for the configured mode, throwing at once for what must stop startup:
 * `none` on an address that reaches beyond the machine, a missing or short password, a bad
 * session key.
 */
export function createAuthenticator(
	options: AuthenticatorOptions,
): Authenticator {
	const { auth, logger } = options;
	let credential: Credential;
	let open: Authenticator["open"];
	if (auth.mode === "verifier") credential = verifierCredential(auth.verifier);
	else if (auth.mode === "none") {
		checkNoneListener(
			options.listener.id,
			options.listener.address,
			auth.trustNetwork,
			logger,
		);
		credential = async () => ({ admitted: true, actor: WEB_CONSOLE_ACTOR });
	} else if (auth.mode === "oidc") {
		if (!options.oidc) throw new Error("the oidc sign-in is not set up");
		credential = options.oidc.login.credential;
		open = (request, rest) =>
			options.oidc?.login.open(request, rest) ?? Promise.resolve(undefined);
	} else {
		const password = new PasswordCredential({
			password: checkPassword(options.env ?? process.env, auth.passwordEnv),
			key: loadSessionKey(options.dataDir, logger),
			actor: WEB_CONSOLE_ACTOR,
			mount: options.mount,
			origin: options.origin,
			sessionDays: auth.sessionDays,
			title: options.title,
			presentation: options.presentation,
			logger,
			loginDelayMs: options.loginDelayMs ?? 1000,
			now: options.now ?? Date.now,
		});
		credential = async (request) => {
			const session = password.check(request);
			return session.valid
				? {
						admitted: true,
						actor: WEB_CONSOLE_ACTOR,
						expiresAt: session.expiresAt,
					}
				: { refusal: session.reason, status: 401, login: true };
		};
		open = (request, rest) => password.open(request, rest);
	}
	const identify = async (
		actor: ActorFacts | undefined,
	): Promise<Identified> => {
		try {
			return await options.identify(actor);
		} catch {
			// A lookup of who they are that fails admits no one.
			return refused("identity failed");
		}
	};
	return {
		...(open ? { open } : {}),
		async authenticate(request) {
			const checked = await credential(request);
			if ("refusal" in checked) return checked;
			if (!checked.admitted) return denied(String(checked.reason));
			const identified = await identify(checked.actor);
			if ("refusal" in identified) return denied(String(identified.refusal));
			if (
				!READ_METHODS.has(request.method) &&
				request.headers.get("origin") !== options.origin
			)
				return denied("foreign origin");
			const { session } = checked as Admitted;
			if (session)
				options.oidc?.login.verified(session, identified.visitor.principal.id);
			return {
				visitor: identified.visitor,
				...(checked.actor ? { actor: checked.actor } : {}),
				...(checked.expiresAt ? { expiresAt: checked.expiresAt } : {}),
				...(session ? { session } : {}),
			};
		},
		async recheck(held) {
			if (held.session) {
				try {
					if (!(await options.oidc?.sessions.alive(held.session)))
						return signedOut("session ended");
				} catch {
					return denied("session lookup failed");
				}
			}
			const identified = await identify(held.actor);
			if ("refusal" in identified) return denied(String(identified.refusal));
			if (held.session)
				options.oidc?.login.verified(
					held.session,
					identified.visitor.principal.id,
				);
			return { visitor: identified.visitor };
		},
	};
}
