import type { ActorFacts } from "pi-roundtable";

/** The verdict on one request: admitted, or refused with a reason for the log. */
export type Verdict =
	| {
			admitted: true;
			/**
			 * Who signed in, as the proxy vouched for them; the console finds their principal through
			 * `IDENTITY` and admits only an owner. Without it, the request is taken as the primary
			 * owner's, as before 0.9, and the console warns once.
			 */
			actor?: ActorFacts;
	  }
	| {
			admitted: false;
			/** Why, for the operator's log. It is never sent to the client, and it must not hold a secret. */
			reason: string;
	  };

/**
 * Decides whether a request comes from someone the operator's proxy authenticated, and who. The
 * console asks it for every request under its path, before anything else, and refuses with 403
 * when it says no, throws, or rejects; then it admits only a person whose principal holds the
 * owner role. A verifier reads the request's headers, which the operator's proxy set after
 * authenticating the person, and must never trust a header a client can forge: see "Threat model"
 * in the README.
 */
export type RequestVerifier = (request: Request) => Verdict | Promise<Verdict>;

/** Admits the request without saying who it is from, as a verifier before 0.9 did. */
export const admit = (): Verdict => ({ admitted: true });
/** Admits the request as coming from the person these facts describe. */
export const admitAs = (actor: ActorFacts): Verdict => ({
	admitted: true,
	actor,
});
export const refuse = (reason: string): Verdict => ({
	admitted: false,
	reason,
});
