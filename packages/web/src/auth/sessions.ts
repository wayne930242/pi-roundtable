import { createHash, randomBytes } from "node:crypto";
import type { SQL } from "bun";
import type { ActorFacts, Migration } from "pi-roundtable";

/** A session's idle limit slides at most this often, so a busy page costs no write per request. */
const SLIDE_AFTER_MS = 3_600_000;
/** Bytes of the random id the cookie holds. */
const TOKEN_BYTES = 32;

/** The actor a session was signed in as, and the id_token claims the host asked to keep. */
export interface SessionActor extends ActorFacts {
	/** Only the claims `oidc.storeClaims` names; replaced at each sign-in and re-verify, never logged. */
	claims?: Readonly<Record<string, unknown>>;
}

/** A live session. */
export interface Session {
	/** The SHA-256 of the cookie's id, in hex: what the rest of the app calls the session. */
	id: string;
	principalId: string;
	actor: SessionActor;
	createdAt: Date;
	lastSeenAt: Date;
	/** When the IdP last vouched for the person: the sign-in, or the latest silent re-verify. */
	verifiedAt: Date;
	/** When the idle limit ends it. */
	expiresAt: Date;
}

interface Row {
	id_hash: Buffer;
	principal_id: string;
	actor: SessionActor | string;
	created_at: Date;
	last_seen_at: Date;
	verified_at: Date;
	expires_at: Date;
}

/** A jsonb column as the driver hands it back: parsed, or as text. */
function actorOf(value: SessionActor | string): SessionActor {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value) as SessionActor;
	} catch (error) {
		throw new Error("the session store holds JSON that cannot be read", {
			cause: error,
		});
	}
}

const hashOf = (token: string): Buffer =>
	createHash("sha256").update(token).digest();

const sessionOf = (row: Row): Session => ({
	id: Buffer.from(row.id_hash).toString("hex"),
	principalId: row.principal_id,
	actor: actorOf(row.actor),
	createdAt: row.created_at,
	lastSeenAt: row.last_seen_at,
	verifiedAt: row.verified_at,
	expiresAt: row.expires_at,
});

export interface WebSessionsOptions {
	/** The idle limit: a session ends after this many days without a visit. */
	days: number;
	/** The clock, in milliseconds; default `Date.now`. Tests set it. */
	now?: () => number;
}

/**
 * The app's own sessions, in `web_sessions`: a 256-bit random id in the cookie, of which only the
 * SHA-256 is stored, with the actor facts the sign-in produced. The session slides: it ends after
 * `days` without a visit, and a visit moves the limit at most once an hour. Nothing here decides
 * what tier the person holds; that is read from `IDENTITY` for every request.
 */
export class WebSessions {
	readonly #sql: SQL;
	readonly #options: WebSessionsOptions;

	constructor(sql: SQL, options: WebSessionsOptions) {
		this.#sql = sql;
		this.#options = options;
	}

	static readonly migration: Migration = {
		name: "web-sessions",
		up: async (sql) => {
			await sql`
				CREATE TABLE IF NOT EXISTS web_sessions (
					id_hash bytea PRIMARY KEY,
					principal_id text NOT NULL,
					actor jsonb NOT NULL,
					created_at timestamptz NOT NULL,
					last_seen_at timestamptz NOT NULL,
					verified_at timestamptz NOT NULL,
					expires_at timestamptz NOT NULL
				)`;
			await sql`CREATE INDEX IF NOT EXISTS web_sessions_principal ON web_sessions (principal_id)`;
			await sql`CREATE INDEX IF NOT EXISTS web_sessions_expires ON web_sessions (expires_at)`;
		},
	};

	#now(): Date {
		return new Date((this.#options.now ?? Date.now)());
	}

	#limit(from: Date): Date {
		return new Date(from.getTime() + this.#options.days * 86_400_000);
	}

	/** Starts a session for a person signed in as `actor`; returns the cookie's id. */
	async create(
		actor: SessionActor,
		principalId: string,
	): Promise<{ token: string; session: Session }> {
		const token = randomBytes(TOKEN_BYTES).toString("base64url");
		const now = this.#now();
		const expires = this.#limit(now);
		await this.#sql`
			INSERT INTO web_sessions (id_hash, principal_id, actor, created_at, last_seen_at, verified_at, expires_at)
			VALUES (${hashOf(token)}, ${principalId}, ${JSON.stringify(actor)}::jsonb, ${now}, ${now}, ${now}, ${expires})`;
		return {
			token,
			session: {
				id: hashOf(token).toString("hex"),
				principalId,
				actor,
				createdAt: now,
				lastSeenAt: now,
				verifiedAt: now,
				expiresAt: expires,
			},
		};
	}

	/**
	 * The live session the cookie's id names, with its limit moved on if it was last seen more than
	 * an hour ago; undefined when there is none or it ended.
	 */
	async touch(token: string): Promise<Session | undefined> {
		const now = this.#now();
		const [row]: Row[] = await this.#sql`
			SELECT * FROM web_sessions WHERE id_hash = ${hashOf(token)} AND expires_at > ${now}`;
		if (!row) return undefined;
		const found = sessionOf(row);
		if (now.getTime() - found.lastSeenAt.getTime() < SLIDE_AFTER_MS)
			return found;
		const expires = this.#limit(now);
		await this.#sql`
			UPDATE web_sessions SET last_seen_at = ${now}, expires_at = ${expires}
			WHERE id_hash = ${hashOf(token)}`;
		return { ...found, lastSeenAt: now, expiresAt: expires };
	}

	/**
	 * Whether the session still stands, without moving its limit; for the recheck of an open socket.
	 * With `reauthHours`, a session the provider has not vouched for within that many hours does not
	 * stand, as on a request.
	 */
	async alive(id: string, reauthHours?: number): Promise<boolean> {
		const now = this.#now();
		const [row]: { n: number }[] = await this.#sql`
			SELECT count(*)::int AS n FROM web_sessions
			WHERE id_hash = ${Buffer.from(id, "hex")} AND expires_at > ${now}
			AND (${reauthHours ?? null}::float8 IS NULL
				OR verified_at >= ${now}::timestamptz - make_interval(secs => ${(reauthHours ?? 0) * 3600}))`;
		return (row?.n ?? 0) > 0;
	}

	/** Ends the session the cookie's id names; returns its id, undefined for none. */
	async end(token: string): Promise<string | undefined> {
		const [row]: { id_hash: Buffer }[] = await this.#sql`
			DELETE FROM web_sessions WHERE id_hash = ${hashOf(token)} RETURNING id_hash`;
		return row ? Buffer.from(row.id_hash).toString("hex") : undefined;
	}

	/** Deletes the sessions past their limit; returns how many. */
	async sweep(): Promise<number> {
		const rows: unknown[] = await this.#sql`
			DELETE FROM web_sessions WHERE expires_at <= ${this.#now()} RETURNING id_hash`;
		return rows.length;
	}

	/**
	 * The id_token claims kept for a person from their newest live session; undefined when they
	 * have none or kept no claims. For a sender that needs, say, a mailbox address.
	 */
	async claimsOf(
		principalId: string,
	): Promise<Readonly<Record<string, unknown>> | undefined> {
		const [row]: Pick<Row, "actor">[] = await this.#sql`
			SELECT actor FROM web_sessions
			WHERE principal_id = ${principalId} AND expires_at > ${this.#now()}
			ORDER BY verified_at DESC LIMIT 1`;
		if (!row) return undefined;
		return actorOf(row.actor).claims;
	}
}
