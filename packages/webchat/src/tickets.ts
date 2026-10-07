import type { WebIdentity } from "./oidc.ts";

export interface TicketBookOptions {
	/** How long a ticket may wait before it is spent. */
	ttlMs: number;
	/** The most tickets held at once; issuing one more drops the oldest. Default 10 000. */
	max?: number;
	now?: () => number;
}

interface Held {
	identity: WebIdentity;
	expiresAt: number;
}

/**
 * One-time tickets: a REST call authenticated with a bearer token gets a ticket, which a browser
 * spends once to open a WebSocket, because a browser cannot set a header on a WebSocket and the
 * token must never sit in a URL. A ticket is random, short-lived, never outlives its token, and
 * lives only in memory.
 */
export class TicketBook {
	readonly #held = new Map<string, Held>();
	readonly #ttlMs: number;
	readonly #max: number;
	readonly #now: () => number;

	constructor(options: TicketBookOptions) {
		this.#ttlMs = options.ttlMs;
		this.#max = options.max ?? 10_000;
		this.#now = options.now ?? Date.now;
	}

	issue(identity: WebIdentity): { ticket: string; expiresAt: Date } {
		const now = this.#now();
		this.#sweep(now);
		while (this.#held.size >= this.#max) {
			const oldest = this.#held.keys().next().value;
			if (oldest === undefined) break;
			this.#held.delete(oldest);
		}
		const ticket = Buffer.from(
			crypto.getRandomValues(new Uint8Array(32)),
		).toString("base64url");
		const expiresAt = Math.min(now + this.#ttlMs, identity.expiresAt.getTime());
		this.#held.set(ticket, { identity, expiresAt });
		return { ticket, expiresAt: new Date(expiresAt) };
	}

	/** The person the ticket was issued to, once; undefined for a spent, old, or unknown ticket. */
	redeem(ticket: string): WebIdentity | undefined {
		const held = this.#held.get(ticket);
		if (!held) return undefined;
		this.#held.delete(ticket);
		return held.expiresAt >= this.#now() ? held.identity : undefined;
	}

	#sweep(now: number): void {
		for (const [ticket, held] of this.#held)
			if (held.expiresAt < now) this.#held.delete(ticket);
	}
}
