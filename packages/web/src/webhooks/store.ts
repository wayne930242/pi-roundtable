import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SQL } from "bun";
import type { Migration } from "pi-roundtable";
import type { WebhookView } from "./types.ts";

/** A webhook as the store keeps it; never its token, only the token's SHA-256. */
export interface StoredWebhook {
	id: string;
	agent: string;
	name: string;
	/** `owner`, or the name of the agent that made it. */
	createdBy: string;
	createdAt: Date;
	lastUsedAt: Date | undefined;
	expiresAt: Date | undefined;
	once: boolean;
}

interface Row {
	id: string;
	agent: string;
	name: string;
	token_hash: string;
	created_by: string;
	created_at: Date;
	last_used_at: Date | null;
	expires_at: Date | null;
	once: boolean;
}

const hashOf = (token: string): string =>
	createHash("sha256").update(token).digest("hex");

const stored = (row: Row): StoredWebhook => ({
	id: row.id,
	agent: row.agent,
	name: row.name,
	createdBy: row.created_by,
	createdAt: new Date(row.created_at),
	lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : undefined,
	expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
	once: row.once,
});

/** What a list shows of a webhook: never the token or its hash. */
export const viewOf = (hook: StoredWebhook): WebhookView => ({
	id: hook.id,
	name: hook.name,
	createdBy: hook.createdBy,
	created: hook.createdAt.toISOString(),
	lastUsed: hook.lastUsedAt?.toISOString() ?? null,
	expiresAt: hook.expiresAt?.toISOString() ?? null,
	once: hook.once,
});

/**
 * The incoming webhooks of the agent rooms, in `web_webhooks`. A webhook is live until it is
 * revoked or its expiry passes; an expired one is marked revoked the next time the store is read.
 */
export class WebhookStore {
	readonly #sql: SQL;

	constructor(sql: SQL) {
		this.#sql = sql;
	}

	static readonly migration: Migration = {
		name: "web-webhooks",
		up: async (sql) => {
			await sql`
				CREATE TABLE IF NOT EXISTS web_webhooks (
					id text PRIMARY KEY,
					agent text NOT NULL,
					name text NOT NULL,
					token_hash text NOT NULL,
					created_by text NOT NULL,
					created_at timestamptz NOT NULL DEFAULT now(),
					last_used_at timestamptz,
					expires_at timestamptz,
					once boolean NOT NULL DEFAULT false,
					revoked_at timestamptz
				)`;
			await sql`CREATE INDEX IF NOT EXISTS web_webhooks_agent ON web_webhooks (agent) WHERE revoked_at IS NULL`;
		},
	};

	/** Makes a webhook; the token is returned this once and only its hash is kept. */
	async create(hook: {
		agent: string;
		name: string;
		createdBy: string;
		expiresAt?: Date;
		once?: boolean;
	}): Promise<{ hook: StoredWebhook; token: string }> {
		const id = randomBytes(9).toString("base64url");
		const token = randomBytes(32).toString("base64url");
		const [row]: Row[] = await this.#sql`
			INSERT INTO web_webhooks (id, agent, name, token_hash, created_by, expires_at, once)
			VALUES (${id}, ${hook.agent}, ${hook.name}, ${hashOf(token)}, ${hook.createdBy},
				${hook.expiresAt ?? null}, ${hook.once === true})
			RETURNING *`;
		if (!row) throw new Error("the webhook was not stored");
		return { hook: stored(row), token };
	}

	/** The agent's live webhooks, the oldest first. */
	async list(agent: string): Promise<StoredWebhook[]> {
		await this.sweep();
		const rows: Row[] = await this.#sql`
			SELECT * FROM web_webhooks WHERE agent = ${agent} AND revoked_at IS NULL
			ORDER BY created_at, id`;
		return rows.map(stored);
	}

	/** Revokes one of the agent's webhooks; false when it has no live one of that id. */
	async revoke(agent: string, id: string): Promise<boolean> {
		const rows: Row[] = await this.#sql`
			UPDATE web_webhooks SET revoked_at = now()
			WHERE id = ${id} AND agent = ${agent} AND revoked_at IS NULL
			RETURNING *`;
		return rows.length > 0;
	}

	/** The live webhook whose id and token these are; undefined for any other, alike. */
	async verify(id: string, token: string): Promise<StoredWebhook | undefined> {
		const [row]: Row[] = await this.#sql`
			SELECT * FROM web_webhooks
			WHERE id = ${id} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`;
		const given = Buffer.from(hashOf(token), "hex");
		// A missing row is compared against a hash of its own, so both answers take the same work.
		const kept = Buffer.from(row?.token_hash ?? hashOf(`${token}.`), "hex");
		return timingSafeEqual(given, kept) && row ? stored(row) : undefined;
	}

	/**
	 * Takes a post for the webhook: records its use, and revokes a `once` webhook with it. False when
	 * it was revoked or expired meanwhile, as when two posts race for a `once` webhook.
	 */
	async accept(id: string): Promise<boolean> {
		const rows: Row[] = await this.#sql`
			UPDATE web_webhooks SET last_used_at = now(),
				revoked_at = CASE WHEN once THEN now() ELSE NULL END
			WHERE id = ${id} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
			RETURNING *`;
		return rows.length > 0;
	}

	/** Marks the webhooks whose expiry passed as revoked; how many. */
	async sweep(): Promise<number> {
		const rows: Row[] = await this.#sql`
			UPDATE web_webhooks SET revoked_at = expires_at
			WHERE revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at <= now()
			RETURNING *`;
		return rows.length;
	}
}
