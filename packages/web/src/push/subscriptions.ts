import type { SQL } from "bun";
import type { Migration } from "pi-roundtable";

/** A device's push subscription: where to post and the keys to seal the message with. */
export interface Subscription {
	endpoint: string;
	principalId: string;
	/** The browser's public key, base64url. */
	p256dh: string;
	/** The browser's authentication secret, base64url. */
	auth: string;
	label?: string;
	createdAt: Date;
	lastOkAt?: Date;
}

interface Row {
	endpoint: string;
	principal_id: string;
	p256dh: string;
	auth: string;
	label: string | null;
	created_at: Date;
	last_ok_at: Date | null;
}

/** Failures in a row after which a subscription is dropped. */
export const MAX_FAILURES = 5;

const subscriptionOf = (row: Row): Subscription => ({
	endpoint: row.endpoint,
	principalId: row.principal_id,
	p256dh: row.p256dh,
	auth: row.auth,
	...(row.label === null ? {} : { label: row.label }),
	createdAt: row.created_at,
	...(row.last_ok_at === null ? {} : { lastOkAt: row.last_ok_at }),
});

/** The devices that asked for push, one row per browser endpoint, in `web_push_subscriptions`. */
export class PushSubscriptions {
	readonly #sql: SQL;

	constructor(sql: SQL) {
		this.#sql = sql;
	}

	static readonly migration: Migration = {
		name: "web-push-subscriptions",
		up: async (sql) => {
			await sql`
				CREATE TABLE IF NOT EXISTS web_push_subscriptions (
					endpoint text PRIMARY KEY,
					principal_id text NOT NULL,
					p256dh text NOT NULL,
					auth text NOT NULL,
					label text,
					created_at timestamptz NOT NULL DEFAULT now(),
					last_ok_at timestamptz,
					failures integer NOT NULL DEFAULT 0
				)`;
			await sql`CREATE INDEX IF NOT EXISTS web_push_subscriptions_principal ON web_push_subscriptions (principal_id)`;
		},
	};

	/**
	 * Stores a device's subscription; a browser that subscribes again replaces its row and starts
	 * clean. An endpoint that is another person's is refused (`"taken"`), and a person who already
	 * has `cap` other devices is refused (`"full"`); the count and the insert share one lock.
	 */
	async save(
		subscription: Omit<Subscription, "createdAt" | "lastOkAt">,
		cap = Number.POSITIVE_INFINITY,
	): Promise<"saved" | "taken" | "full"> {
		return this.#sql.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`web-push:${subscription.principalId}`}, 0))`;
			const [counted]: { n: number }[] = await tx`
				SELECT count(*)::int AS n FROM web_push_subscriptions
				WHERE principal_id = ${subscription.principalId} AND endpoint <> ${subscription.endpoint}`;
			if ((counted?.n ?? 0) >= cap) return "full";
			const rows: unknown[] = await tx`
				INSERT INTO web_push_subscriptions (endpoint, principal_id, p256dh, auth, label)
				VALUES (${subscription.endpoint}, ${subscription.principalId}, ${subscription.p256dh},
					${subscription.auth}, ${subscription.label ?? null})
				ON CONFLICT (endpoint) DO UPDATE SET
					p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
					label = EXCLUDED.label, failures = 0
				WHERE web_push_subscriptions.principal_id = EXCLUDED.principal_id
				RETURNING endpoint`;
			return rows.length > 0 ? "saved" : "taken";
		});
	}

	/** Every device, oldest first. */
	async all(): Promise<Subscription[]> {
		const rows: Row[] = await this
			.#sql`SELECT * FROM web_push_subscriptions ORDER BY created_at, endpoint`;
		return rows.map(subscriptionOf);
	}

	/** One person's devices, oldest first. */
	async of(principalId: string): Promise<Subscription[]> {
		const rows: Row[] = await this.#sql`
			SELECT * FROM web_push_subscriptions WHERE principal_id = ${principalId}
			ORDER BY created_at, endpoint`;
		return rows.map(subscriptionOf);
	}

	/** Drops a person's device; false when they have no such one. */
	async remove(endpoint: string, principalId: string): Promise<boolean> {
		const rows: unknown[] = await this.#sql`
			DELETE FROM web_push_subscriptions
			WHERE endpoint = ${endpoint} AND principal_id = ${principalId} RETURNING endpoint`;
		return rows.length > 0;
	}

	/** Drops a device the push service says is gone. */
	async forget(endpoint: string): Promise<void> {
		await this
			.#sql`DELETE FROM web_push_subscriptions WHERE endpoint = ${endpoint}`;
	}

	/** Notes that a push was accepted. */
	async delivered(endpoint: string): Promise<void> {
		await this
			.#sql`UPDATE web_push_subscriptions SET failures = 0, last_ok_at = now() WHERE endpoint = ${endpoint}`;
	}

	/** Notes a failed push; the fifth failure in a row drops the device. Returns whether it was dropped. */
	async failed(endpoint: string): Promise<boolean> {
		const rows: unknown[] = await this.#sql`
			DELETE FROM web_push_subscriptions
			WHERE endpoint = ${endpoint}
				AND failures + 1 >= ${MAX_FAILURES} RETURNING endpoint`;
		if (rows.length > 0) return true;
		await this
			.#sql`UPDATE web_push_subscriptions SET failures = failures + 1 WHERE endpoint = ${endpoint}`;
		return false;
	}
}
