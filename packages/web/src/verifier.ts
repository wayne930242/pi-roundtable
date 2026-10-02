/** The verdict on one request: admitted, or refused with a reason for the log. */
export type Verdict =
	| { admitted: true }
	| {
			admitted: false;
			/** Why, for the operator's log. It is never sent to the client, and it must not hold a secret. */
			reason: string;
	  };

/**
 * Decides whether a request comes from the owner. The console asks it for every request under
 * its path, before anything else, and refuses with 403 when it says no, throws, or rejects.
 * A verifier reads the request's headers, which the operator's proxy set after authenticating the
 * owner, and must never trust a header a client can forge: see "Threat model" in the README.
 */
export type RequestVerifier = (request: Request) => Verdict | Promise<Verdict>;

export const admit = (): Verdict => ({ admitted: true });
export const refuse = (reason: string): Verdict => ({
	admitted: false,
	reason,
});
