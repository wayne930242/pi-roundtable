import type { JWTVerifyGetKey } from "jose";
import type { ActorFacts, Logger } from "pi-roundtable";
import type { ConsolePresentation } from "../features.ts";
import type { ResolvedOidc } from "../options.ts";
import type { Identified } from "../visitors.ts";
import type { ProviderMetadata } from "./oidc-provider.ts";
import type { WebSessions } from "./sessions.ts";

/** What a sign-in did, for the event and the people-naming hooks; never carries a token or a claim. */
export interface SignedIn {
	principalId: string;
	/** `<provider>:<subject>`. */
	speakerId: string;
	provider: string;
	name: string;
}

export interface OidcLoginOptions {
	settings: ResolvedOidc;
	metadata: ProviderMetadata;
	/** The client secret, when the client is confidential. */
	clientSecret?: string;
	sessions: WebSessions;
	/** The session key, which signs the pending-login cookie. */
	key: Buffer;
	origin: string;
	mount: string;
	/** The app's surface, such as `app`: the prefix of the roles a sign-in carries. */
	surface: string;
	routing: "hash" | "path";
	title: string;
	presentation?: ConsolePresentation | undefined;
	/** Who the actor is and the tier they hold; the same admission every request passes. */
	identify(actor: ActorFacts): Promise<Identified>;
	/** A sign-in completed: the host's event and name hooks. Never throws into the flow. */
	onSignIn?(info: SignedIn): void | Promise<void>;
	/** A session ended (logout), so the sockets on it can close. */
	onEnded?(sessionId: string): void;
	/** A request or an open socket proved a live session of this person: the host's `onSessionVerified`. */
	onSessionVerified?(principalId: string): void | Promise<void>;
	logger: Logger;
	/** The provider's signing keys; the published ones by default. */
	keys?: JWTVerifyGetKey;
	fetch?: typeof fetch;
	/** The clock, in milliseconds; default `Date.now`. */
	now?: () => number;
}

export interface Pending {
	/** state */
	s: string;
	/** nonce */
	n: string;
	/** PKCE verifier */
	v: string;
	/** where to go afterwards */
	x?: string;
	/** the request was silent (`prompt=none`) */
	i: boolean;
	/** expires, ms */
	e: number;
}
