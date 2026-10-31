import type { SQL } from "bun";
import type { Migration } from "pi-roundtable";
import { jsonValuesMigration } from "../host/stored-json.ts";
import type { OpenTarget } from "../web-app.ts";

/** Where a tap on a notice goes. */
export type NoticeOpen = OpenTarget;

/** A notice as it is stored. */
export interface StoredNotice {
	tag: string;
	title: string;
	body?: string;
	open?: NoticeOpen;
	urgency: "normal" | "high";
	ackable: boolean;
	raisedAt: Date;
	resolvedAt?: Date;
	resolvedBy?: string;
	reason?: string;
}

/** One notice with the state of the person it is shown to. */
export interface NoticeFor extends StoredNotice {
	ackedAt?: Date;
}

interface NoticeRow {
	tag: string;
	title: string;
	body: string | null;
	open: NoticeOpen | string | null;
	urgency: "normal" | "high";
	ackable: boolean;
	raised_at: Date;
	resolved_at: Date | null;
	resolved_by: string | null;
	reason: string | null;
	acked_at?: Date | null;
}

/** A jsonb column as the driver hands it back: parsed, or as text. */
function openOf(value: NoticeRow["open"]): NoticeOpen | undefined {
	if (value === null) return undefined;
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value) as NoticeOpen;
	} catch {
		return undefined;
	}
}

const noticeOf = (row: NoticeRow): StoredNotice => {
	const open = openOf(row.open);
	return {
		tag: row.tag,
		title: row.title,
		...(row.body === null ? {} : { body: row.body }),
		...(open ? { open } : {}),
		urgency: row.urgency,
		ackable: row.ackable,
		raisedAt: row.raised_at,
		...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
		...(row.resolved_by ? { resolvedBy: row.resolved_by } : {}),
		...(row.reason ? { reason: row.reason } : {}),
	};
};

/** Resolved notices are kept this long, in days, and then deleted. */
const KEEP_RESOLVED_DAYS = 30;

/** What `pending` reports for a notice. */
export interface NoticeState {
	raisedAt: Date;
	to: readonly string[];
	acked: readonly { principalId: string; at: Date }[];
	received: readonly string[];
	opened: readonly string[];
}

/** The notices (`web_notices`) and who each one is addressed to and how they answered (`web_notice_recipients`). */
export class NoticeStore {
	readonly #sql: SQL;

	constructor(sql: SQL) {
		this.#sql = sql;
	}

	/** Its jsonb columns stored as the JSON values themselves, not as the text of them. */
	static readonly jsonValuesMigration: Migration = jsonValuesMigration(
		"web-notices-json-values",
		"web_notices",
		["open"],
	);

	static readonly migration: Migration = {
		name: "web-notices",
		up: async (sql) => {
			await sql`
				CREATE TABLE IF NOT EXISTS web_notices (
					tag text PRIMARY KEY,
					title text NOT NULL,
					body text,
					open jsonb,
					urgency text NOT NULL,
					ackable boolean NOT NULL DEFAULT false,
					raised_at timestamptz NOT NULL DEFAULT now(),
					resolved_at timestamptz,
					resolved_by text,
					reason text
				)`;
			await sql`
				CREATE TABLE IF NOT EXISTS web_notice_recipients (
					tag text NOT NULL REFERENCES web_notices (tag) ON DELETE CASCADE,
					principal_id text NOT NULL,
					added_at timestamptz NOT NULL DEFAULT now(),
					acked_at timestamptz,
					received_at timestamptz,
					opened_at timestamptz,
					PRIMARY KEY (tag, principal_id)
				)`;
			await sql`CREATE INDEX IF NOT EXISTS web_notice_recipients_principal ON web_notice_recipients (principal_id)`;
		},
	};

	/**
	 * Raises a notice, or raises it again: the notice is replaced and reopened, and its recipients
	 * become exactly `to`, each starting unanswered.
	 */
	async raise(
		notice: Omit<
			StoredNotice,
			"raisedAt" | "resolvedAt" | "resolvedBy" | "reason"
		>,
		to: readonly string[],
	): Promise<void> {
		await this.#sql.begin(async (tx) => {
			await tx`
				INSERT INTO web_notices (tag, title, body, open, urgency, ackable)
				VALUES (${notice.tag}, ${notice.title}, ${notice.body ?? null},
					${notice.open ? JSON.stringify(notice.open) : null}::text::jsonb,
					${notice.urgency}, ${notice.ackable})
				ON CONFLICT (tag) DO UPDATE SET
					title = EXCLUDED.title, body = EXCLUDED.body, open = EXCLUDED.open,
					urgency = EXCLUDED.urgency, ackable = EXCLUDED.ackable,
					raised_at = now(), resolved_at = NULL, resolved_by = NULL, reason = NULL`;
			await tx`DELETE FROM web_notice_recipients WHERE tag = ${notice.tag}`;
			for (const principalId of to)
				await tx`
					INSERT INTO web_notice_recipients (tag, principal_id)
					VALUES (${notice.tag}, ${principalId})`;
		});
	}

	/** Adds recipients to an open notice and starts the ones who have not handled it over; returns who now gets it again. */
	async renotify(
		tag: string,
		add: readonly string[],
	): Promise<readonly string[] | undefined> {
		return this.#sql.begin(async (tx) => {
			const [found]: { tag: string }[] = await tx`
				SELECT tag FROM web_notices WHERE tag = ${tag} AND resolved_at IS NULL FOR UPDATE`;
			if (!found) return undefined;
			for (const principalId of add)
				await tx`
					INSERT INTO web_notice_recipients (tag, principal_id)
					VALUES (${tag}, ${principalId}) ON CONFLICT DO NOTHING`;
			const rows: { principal_id: string }[] = await tx`
				SELECT principal_id FROM web_notice_recipients
				WHERE tag = ${tag} AND acked_at IS NULL ORDER BY added_at, principal_id`;
			return rows.map((row) => row.principal_id);
		});
	}

	/** Closes a notice; false when there is none open under the tag. */
	async resolve(
		tag: string,
		by: { principalId?: string; reason: string } | undefined,
	): Promise<readonly string[] | undefined> {
		return this.#sql.begin(async (tx) => {
			const rows: { tag: string }[] = await tx`
				UPDATE web_notices SET resolved_at = now(), resolved_by = ${by?.principalId ?? null},
					reason = ${by?.reason ?? null}
				WHERE tag = ${tag} AND resolved_at IS NULL RETURNING tag`;
			if (rows.length === 0) return undefined;
			const to: { principal_id: string }[] = await tx`
				SELECT principal_id FROM web_notice_recipients WHERE tag = ${tag}`;
			return to.map((row) => row.principal_id);
		});
	}

	/** The notice as the person sees it, if it is addressed to them. */
	async of(tag: string, principalId: string): Promise<NoticeFor | undefined> {
		const [row]: NoticeRow[] = await this.#sql`
			SELECT n.*, r.acked_at FROM web_notices n
			JOIN web_notice_recipients r ON r.tag = n.tag
			WHERE n.tag = ${tag} AND r.principal_id = ${principalId}`;
		return row ? this.#forPerson(row) : undefined;
	}

	/** The notices not resolved that are addressed to the person, newest first. */
	async openFor(principalId: string): Promise<NoticeFor[]> {
		const rows: NoticeRow[] = await this.#sql`
			SELECT n.*, r.acked_at FROM web_notices n
			JOIN web_notice_recipients r ON r.tag = n.tag
			WHERE r.principal_id = ${principalId} AND n.resolved_at IS NULL
			ORDER BY n.raised_at DESC, n.tag
			LIMIT 200`;
		return rows.map((row) => this.#forPerson(row));
	}

	#forPerson(row: NoticeRow): NoticeFor {
		return {
			...noticeOf(row),
			...(row.acked_at ? { ackedAt: row.acked_at } : {}),
		};
	}

	/** How many notices the person has to handle: addressed to them, open, wanting an answer and not acked. */
	async unhandled(principalId: string): Promise<number> {
		const [found]: { n: number }[] = await this.#sql`
			SELECT count(*)::int AS n FROM web_notices n
			JOIN web_notice_recipients r ON r.tag = n.tag
			WHERE r.principal_id = ${principalId} AND n.resolved_at IS NULL
				AND n.ackable AND r.acked_at IS NULL`;
		return found?.n ?? 0;
	}

	/** Marks a notice handled by the person; false when it is not addressed to them, not open, or not ackable. */
	async ack(tag: string, principalId: string): Promise<boolean> {
		const rows: unknown[] = await this.#sql`
			UPDATE web_notice_recipients r SET acked_at = COALESCE(r.acked_at, now())
			FROM web_notices n
			WHERE n.tag = r.tag AND r.tag = ${tag} AND r.principal_id = ${principalId}
				AND n.resolved_at IS NULL AND n.ackable
			RETURNING r.tag`;
		return rows.length > 0;
	}

	/**
	 * Records that the person's device received or opened the notice; false when the notice is not
	 * addressed to them. The first time of each is kept.
	 */
	async receipt(
		tag: string,
		principalId: string,
		event: "received" | "opened",
	): Promise<boolean> {
		const rows: unknown[] =
			event === "received"
				? await this.#sql`
					UPDATE web_notice_recipients SET received_at = COALESCE(received_at, now())
					WHERE tag = ${tag} AND principal_id = ${principalId} RETURNING tag`
				: await this.#sql`
					UPDATE web_notice_recipients SET opened_at = COALESCE(opened_at, now())
					WHERE tag = ${tag} AND principal_id = ${principalId} RETURNING tag`;
		return rows.length > 0;
	}

	async pending(tag: string): Promise<NoticeState | undefined> {
		const [notice]: { raised_at: Date }[] = await this.#sql`
			SELECT raised_at FROM web_notices WHERE tag = ${tag} AND resolved_at IS NULL`;
		if (!notice) return undefined;
		const rows: {
			principal_id: string;
			acked_at: Date | null;
			received_at: Date | null;
			opened_at: Date | null;
		}[] = await this.#sql`
			SELECT principal_id, acked_at, received_at, opened_at FROM web_notice_recipients
			WHERE tag = ${tag} ORDER BY added_at, principal_id`;
		return {
			raisedAt: notice.raised_at,
			to: rows.map((row) => row.principal_id),
			acked: rows.flatMap((row) =>
				row.acked_at
					? [{ principalId: row.principal_id, at: row.acked_at }]
					: [],
			),
			received: rows
				.filter((row) => row.received_at)
				.map((row) => row.principal_id),
			opened: rows
				.filter((row) => row.opened_at)
				.map((row) => row.principal_id),
		};
	}

	/** Whether a push for this tag was delivered to the person: they have a device that holds its notification. */
	async delivered(tag: string, principalId: string): Promise<boolean> {
		const [found]: { n: number }[] = await this.#sql`
			SELECT count(*)::int AS n FROM web_push_outbox o
			JOIN web_push_deliveries d ON d.outbox_id = o.id
			WHERE o.tag = ${tag} AND o.principal_id = ${principalId}
				AND o.kind = 'notice' AND d.result = 'sent'`;
		return (found?.n ?? 0) > 0;
	}

	/** Deletes the notices resolved long ago; returns how many. */
	async sweep(): Promise<number> {
		const rows: unknown[] = await this.#sql`
			DELETE FROM web_notices
			WHERE resolved_at < now() - make_interval(days => ${KEEP_RESOLVED_DAYS}) RETURNING tag`;
		return rows.length;
	}
}
