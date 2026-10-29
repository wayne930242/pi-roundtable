import type { SQL } from "bun";
import type { Migration } from "pi-roundtable";

/**
 * What a push is about; a sender renders its words from it. A `clear` row has no words: it tells
 * the devices a notice is gone (close its notification, set the count), and a transport that has
 * no such thing skips it.
 */
export type OutboxKind = "card" | "reply" | "notice" | "test" | "clear";

/**
 * One push to one person, queued for a sender. It carries what a sender needs to word and address
 * the push, and no host-room content: `title` and `body` are present only with `push.content`
 * `full`.
 */
export interface OutboxRow {
	id: number;
	kind: OutboxKind;
	/** Pushes with one tag replace each other on a device; a notice's tag is its dedupe key. */
	tag: string;
	principalId: string;
	/** Where a tap goes: a path under the app's origin. */
	open: string;
	urgency: "normal" | "high";
	/** The count the app icon shows after this push: the person's notices not handled. */
	badge: number;
	title?: string;
	body?: string;
	/** The transports that may carry the row, in order; absent = all the sender has, in order. */
	via?: readonly string[];
	createdAt: Date;
}

export type NewOutboxRow = Omit<OutboxRow, "id" | "createdAt">;

/** What a transport said of one delivery. */
export type DeliveryResult = "sent" | "gone" | "failed" | "skipped";

interface Row {
	id: string | number;
	kind: OutboxKind;
	tag: string;
	principal_id: string;
	open: string;
	urgency: "normal" | "high";
	badge: number;
	title: string | null;
	body: string | null;
	via: string[] | null;
	created_at: Date;
}

const rowOf = (row: Row): OutboxRow => ({
	id: Number(row.id),
	kind: row.kind,
	tag: row.tag,
	principalId: row.principal_id,
	open: row.open,
	urgency: row.urgency,
	badge: row.badge,
	...(row.title === null ? {} : { title: row.title }),
	...(row.body === null ? {} : { body: row.body }),
	...(row.via === null ? {} : { via: row.via }),
	createdAt: row.created_at,
});

/** A claimed row that no sender finished is claimed again after this long. */
const CLAIM_LEASE_SECONDS = 60;
/** Finished rows, deliveries and receipts are kept this long, in days. */
export const OUTBOX_KEEP_DAYS = 30;
/** A device that returned a receipt this recently counts as working. */
export const RECEIPT_WINDOW_DAYS = 30;

/** A receipt the service worker posted: the notification arrived, or was opened. */
export type ReceiptEvent = "received" | "opened";

/**
 * The queue between the app and the process that signs and sends pushes (`web_push_outbox`), what
 * the sender did with each row (`web_push_deliveries`), and the receipts the service worker posts
 * back (`web_push_receipts`). The app and an external sender both use it: the sender needs only to
 * read and update the outbox and insert deliveries.
 */
export class PushOutbox {
	readonly #sql: SQL;

	constructor(sql: SQL) {
		this.#sql = sql;
	}

	static readonly migration: Migration = {
		name: "web-push-outbox",
		up: async (sql) => {
			await sql`
				CREATE TABLE IF NOT EXISTS web_push_outbox (
					id bigserial PRIMARY KEY,
					kind text NOT NULL,
					tag text NOT NULL,
					principal_id text NOT NULL,
					open text NOT NULL,
					urgency text NOT NULL,
					badge integer NOT NULL DEFAULT 0,
					title text,
					body text,
					via text[],
					created_at timestamptz NOT NULL DEFAULT now(),
					claimed_at timestamptz,
					done_at timestamptz
				)`;
			await sql`CREATE INDEX IF NOT EXISTS web_push_outbox_open ON web_push_outbox (id) WHERE done_at IS NULL`;
			await sql`CREATE INDEX IF NOT EXISTS web_push_outbox_done ON web_push_outbox (done_at)`;
			await sql`
				CREATE TABLE IF NOT EXISTS web_push_deliveries (
					outbox_id bigint NOT NULL,
					transport text NOT NULL,
					endpoint_hash text,
					result text NOT NULL,
					at timestamptz NOT NULL DEFAULT now()
				)`;
			await sql`CREATE INDEX IF NOT EXISTS web_push_deliveries_outbox ON web_push_deliveries (outbox_id)`;
			await sql`
				CREATE TABLE IF NOT EXISTS web_push_receipts (
					principal_id text NOT NULL,
					tag text NOT NULL,
					event text NOT NULL,
					at timestamptz NOT NULL DEFAULT now()
				)`;
			await sql`CREATE INDEX IF NOT EXISTS web_push_receipts_principal ON web_push_receipts (principal_id, at DESC)`;
		},
	};

	/** Queues a push; returns its id. */
	async enqueue(row: NewOutboxRow): Promise<number> {
		const [made]: { id: string | number }[] = await this.#sql`
			INSERT INTO web_push_outbox (kind, tag, principal_id, open, urgency, badge, title, body, via)
			VALUES (${row.kind}, ${row.tag}, ${row.principalId}, ${row.open}, ${row.urgency},
				${row.badge}, ${row.title ?? null}, ${row.body ?? null},
				${row.via ? this.#sql.array([...row.via], "TEXT") : null})
			RETURNING id`;
		if (!made) throw new Error("the push outbox did not return an id");
		return Number(made.id);
	}

	/** Takes up to `limit` rows no sender holds, oldest first; a row held longer than the lease is taken again. */
	async claim(limit: number): Promise<OutboxRow[]> {
		const rows: Row[] = await this.#sql`
			UPDATE web_push_outbox SET claimed_at = now()
			WHERE id IN (
				SELECT id FROM web_push_outbox
				WHERE done_at IS NULL
					AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => ${CLAIM_LEASE_SECONDS}))
				ORDER BY id LIMIT ${limit}
				FOR UPDATE SKIP LOCKED)
			RETURNING *`;
		return rows.map(rowOf).sort((a, b) => a.id - b.id);
	}

	/** Records what the transports said of a row and finishes it. */
	async finish(
		id: number,
		deliveries: readonly { transport: string; result: DeliveryResult }[],
	): Promise<void> {
		await this.#sql.begin(async (tx) => {
			for (const delivery of deliveries)
				await tx`
					INSERT INTO web_push_deliveries (outbox_id, transport, result)
					VALUES (${id}, ${delivery.transport}, ${delivery.result})`;
			await tx`UPDATE web_push_outbox SET done_at = now() WHERE id = ${id}`;
		});
	}

	/** Whether the person has a queued push of this kind and tag, which makes a receipt for it theirs. */
	async has(
		principalId: string,
		kind: OutboxKind,
		tag: string,
	): Promise<boolean> {
		const [found]: { n: number }[] = await this.#sql`
			SELECT count(*)::int AS n FROM web_push_outbox
			WHERE principal_id = ${principalId} AND kind = ${kind} AND tag = ${tag}`;
		return (found?.n ?? 0) > 0;
	}

	async receipt(
		principalId: string,
		tag: string,
		event: ReceiptEvent,
	): Promise<void> {
		await this.#sql`
			INSERT INTO web_push_receipts (principal_id, tag, event)
			VALUES (${principalId}, ${tag}, ${event})`;
	}

	/** When a device of the person last posted a receipt, within the window; undefined for none. */
	async lastReceiptAt(
		principalId: string,
		withinDays = RECEIPT_WINDOW_DAYS,
	): Promise<Date | undefined> {
		const [found]: { at: Date | null }[] = await this.#sql`
			SELECT max(at) AS at FROM web_push_receipts
			WHERE principal_id = ${principalId}
				AND at > now() - make_interval(days => ${withinDays})`;
		return found?.at ?? undefined;
	}

	/** Deletes finished rows, their deliveries and old receipts; returns how many rows went. */
	async sweep(): Promise<number> {
		const gone: { id: string | number }[] = await this.#sql`
			DELETE FROM web_push_outbox
			WHERE done_at < now() - make_interval(days => ${OUTBOX_KEEP_DAYS}) RETURNING id`;
		await this.#sql`
			DELETE FROM web_push_deliveries d WHERE NOT EXISTS (
				SELECT 1 FROM web_push_outbox o WHERE o.id = d.outbox_id)`;
		await this.#sql`
			DELETE FROM web_push_receipts
			WHERE at < now() - make_interval(days => ${OUTBOX_KEEP_DAYS})`;
		return gone.length;
	}
}
