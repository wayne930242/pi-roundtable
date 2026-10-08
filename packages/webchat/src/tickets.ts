import type { WebIdentity } from "./oidc.ts";

export interface TicketBookOptions {
	/** How long a ticket may wait before it is spent. */
	ttlMs: number;
	/** The most tickets held at once, for everyone together; issuing one more drops the oldest. Default 10 000. */
	max?: number;
	/**
	 * The most tickets one person holds at once; issuing one more drops that person's oldest, so
	 * nobody can push out anyone else's. Default 5.
	 */
	perPrincipal?: number;
	now?: () => number;
}

interface Held {
	principalId: string;
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
	/** Each person's tickets, oldest first. */
	readonly #byPerson = new Map<string, Set<string>>();
	readonly #ttlMs: number;
	readonly #max: number;
	readonly #perPrincipal: number;
	readonly #now: () => number;

	constructor(options: TicketBookOptions) {
		this.#ttlMs = options.ttlMs;
		this.#max = options.max ?? 10_000;
		this.#perPrincipal = options.perPrincipal ?? 5;
		this.#now = options.now ?? Date.now;
	}

	issue(
		identity: WebIdentity,
		principalId: string,
	): { ticket: string; expiresAt: Date } {
		const now = this.#now();
		this.#sweep(now);
		const mine = this.#byPerson.get(principalId) ?? new Set<string>();
		for (const oldest of mine) {
			if (mine.size < this.#perPrincipal) break;
			this.#drop(oldest);
		}
		while (this.#held.size >= this.#max) {
			const oldest = this.#held.keys().next().value;
			if (oldest === undefined) break;
			this.#drop(oldest);
		}
		const ticket = Buffer.from(
			crypto.getRandomValues(new Uint8Array(32)),
		).toString("base64url");
		const expiresAt = Math.min(now + this.#ttlMs, identity.expiresAt.getTime());
		this.#held.set(ticket, { identity, principalId, expiresAt });
		mine.add(ticket);
		this.#byPerson.set(principalId, mine);
		return { ticket, expiresAt: new Date(expiresAt) };
	}

	/** The person the ticket was issued to, once; undefined for a spent, old, or unknown ticket. */
	redeem(
		ticket: string,
	): { identity: WebIdentity; principalId: string } | undefined {
		const held = this.#held.get(ticket);
		if (!held) return undefined;
		this.#drop(ticket);
		return held.expiresAt >= this.#now()
			? { identity: held.identity, principalId: held.principalId }
			: undefined;
	}

	#drop(ticket: string): void {
		const held = this.#held.get(ticket);
		if (!held) return;
		this.#held.delete(ticket);
		const mine = this.#byPerson.get(held.principalId);
		mine?.delete(ticket);
		if (mine?.size === 0) this.#byPerson.delete(held.principalId);
	}

	#sweep(now: number): void {
		for (const [ticket, held] of this.#held)
			if (held.expiresAt < now) this.#drop(ticket);
	}
}
