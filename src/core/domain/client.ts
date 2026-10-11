/** A binary piece of a client call's result, such as a screenshot. */
export interface ClientPart {
	mimeType: string;
	data: Uint8Array;
}

/** Why a client call did not return a value. */
export type ClientCallError =
	/** The turn has no client, or its client is gone. */
	| "no_client"
	/** The client declined the call. */
	| "refused"
	/** The client did not answer in time. */
	| "timeout"
	/** The turn was stopped, or the caller's signal aborted, before the client answered. */
	| "cancelled"
	/** The client's connection closed before it answered. */
	| "disconnected"
	/** The client's answer passed the size the transport accepts. */
	| "too_large"
	/** A call is already open on this client; make calls one at a time. */
	| "busy"
	/** The client tried and failed, or answered with something that is not a result. */
	| "failed";

/** What a client call comes to: the value the client answered with and its binary parts, or why not. */
export type ClientCallResult =
	| { ok: true; value: unknown; parts: readonly ClientPart[] }
	| { ok: false; error: ClientCallError; message: string };

/** How one client call is bounded. */
export interface ClientCallOptions {
	/** How long to wait for the client's answer; the transport has a default and its own ceiling. */
	timeoutMs?: number;
	/** The most bytes of JSON the answer's value may take; the transport has a default and its own ceiling. */
	maxValueBytes?: number;
	/**
	 * Cancels the call when it aborts: the client is told, and the call resolves `cancelled`. A tool
	 * need not pass the turn's signal; the core adds it to every call.
	 */
	signal?: AbortSignal;
}

/**
 * What the client that started a turn can do for its tools, such as a browser extension running a
 * function on the page the person has open. Only the transport that carries the turn provides one.
 */
export interface ClientPort {
	/** The names of the functions the client declared it can run. */
	readonly names: readonly string[];
	/**
	 * Asks the client to run `name` with `args`. It never rejects for a transport problem: a failure
	 * resolves `{ ok: false }`. One call is open at a time; another call meanwhile resolves `busy`.
	 * The value and the parts come from the client, so a tool treats them as untrusted data.
	 */
	call(
		name: string,
		args: unknown,
		options?: ClientCallOptions,
	): Promise<ClientCallResult>;
}
