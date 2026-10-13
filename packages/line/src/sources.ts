import type { SQL } from "bun";
import type { LineApi } from "./api.ts";
import { LineError } from "./errors.ts";
import { parseSourceKey, type SourceKind } from "./events.ts";

export type SourceStatus = "pending" | "allowed" | "left" | "blocked";

/** A chat the bot has seen. Only counts and times are kept for a chat that is not allowed. */
export interface LineSource {
	key: string;
	kind: SourceKind;
	status: SourceStatus;
	firstSeenAt: string;
	lastSeenAt: string;
	statusChangedAt: string;
	eventCount: number;
	messageCount: number;
}

export interface LineSourceSummary extends LineSource {
	/** The group's name as LINE shows it; null for a room or a person, which have none. */
	name: string | null;
}

interface Row {
	source_key: string;
	kind: SourceKind;
	status: SourceStatus;
	first_seen_at: Date;
	last_seen_at: Date;
	status_changed_at: Date;
	event_count: string | number;
	message_count: string | number;
}

const sourceOf = (row: Row): LineSource => ({
	key: row.source_key,
	kind: row.kind,
	status: row.status,
	firstSeenAt: row.first_seen_at.toISOString(),
	lastSeenAt: row.last_seen_at.toISOString(),
	statusChangedAt: row.status_changed_at.toISOString(),
	eventCount: Number(row.event_count),
	messageCount: Number(row.message_count),
});

/** What the host does with the chats the bot has seen: list them, allow or block them. It never creates a channel. */
export interface LineSources {
	/** Chats waiting for a decision, oldest first. */
	pending(): Promise<LineSource[]>;
	/** Every chat, or only those with `status`, oldest first. */
	list(status?: SourceStatus): Promise<LineSource[]>;
	/** One chat, or undefined when the bot has not seen it. */
	get(key: string): Promise<LineSource | undefined>;
	/**
	 * Mirrors a chat from now on. Events that arrived before are gone: they were dropped unread.
	 * Throws `LineError` `unknown_source` for a chat never seen, and `source_left` for one the
	 * bot has left.
	 */
	allow(key: string): Promise<LineSource>;
	/** Stops mirroring a chat and drops the events of it still waiting in the inbox. Throws `unknown_source` for a chat never seen. */
	block(key: string): Promise<LineSource>;
	/** The chat with its group name, asked of LINE; throws when LINE refuses or does not answer. */
	summary(key: string): Promise<LineSourceSummary>;
}

function checkedKey(key: string): { kind: SourceKind; id: string } {
	const parsed = parseSourceKey(key);
	if (!parsed)
		throw new LineError(
			"bad_source_key",
			"line: a source key is line:<group|room|user>:<id>",
		);
	return parsed;
}

export class PgSources implements LineSources {
	readonly #sql: SQL;
	readonly #api: () => LineApi;
	readonly #now: () => Date;

	constructor(sql: SQL, api: () => LineApi, now: () => Date) {
		this.#sql = sql;
		this.#api = api;
		this.#now = now;
	}

	async pending(): Promise<LineSource[]> {
		return this.list("pending");
	}

	async list(status?: SourceStatus): Promise<LineSource[]> {
		const rows: Row[] = status
			? await this
					.#sql`SELECT * FROM line_sources WHERE status = ${status} ORDER BY first_seen_at, source_key`
			: await this
					.#sql`SELECT * FROM line_sources ORDER BY first_seen_at, source_key`;
		return rows.map(sourceOf);
	}

	async get(key: string): Promise<LineSource | undefined> {
		checkedKey(key);
		const rows: Row[] = await this
			.#sql`SELECT * FROM line_sources WHERE source_key = ${key}`;
		return rows[0] ? sourceOf(rows[0]) : undefined;
	}

	async allow(key: string): Promise<LineSource> {
		checkedKey(key);
		const now = this.#now();
		const rows: Row[] = await this.#sql`UPDATE line_sources
			SET status = 'allowed', status_changed_at = ${now}
			WHERE source_key = ${key} AND status IN ('pending', 'blocked', 'allowed')
			RETURNING *`;
		if (rows[0]) return sourceOf(rows[0]);
		throw (await this.get(key))
			? new LineError("source_left", "line: the bot has left that chat")
			: new LineError("unknown_source", "line: the bot has not seen that chat");
	}

	async block(key: string): Promise<LineSource> {
		checkedKey(key);
		const now = this.#now();
		return this.#sql.begin(async (sql) => {
			const rows: Row[] = await sql`UPDATE line_sources
				SET status = 'blocked', status_changed_at = ${now}
				WHERE source_key = ${key} RETURNING *`;
			if (!rows[0])
				throw new LineError(
					"unknown_source",
					"line: the bot has not seen that chat",
				);
			// What waits unread is dropped with its payload; an event being handled finishes.
			await sql`UPDATE line_inbox
				SET status = 'skipped', payload = NULL, last_error_code = 'source_blocked', completed_at = ${now}
				WHERE source_key = ${key} AND status = 'pending'`;
			return sourceOf(rows[0]);
		});
	}

	async summary(key: string): Promise<LineSourceSummary> {
		const { kind, id } = checkedKey(key);
		const source = await this.get(key);
		if (!source)
			throw new LineError(
				"unknown_source",
				"line: the bot has not seen that chat",
			);
		const name = kind === "group" ? await this.#api().groupName(id) : null;
		return { ...source, name };
	}

	/**
	 * Records that the bot is in a chat (a `join` event): a chat it had left needs a new decision,
	 * so it goes back to pending. Ignores an event older than the last membership change applied.
	 */
	async markJoined(key: string, timestamp: number): Promise<void> {
		await this.#sql`UPDATE line_sources
			SET membership_ts = ${timestamp},
				status = CASE WHEN status = 'left' THEN 'pending' ELSE status END,
				status_changed_at = CASE WHEN status = 'left' THEN ${this.#now()} ELSE status_changed_at END
			WHERE source_key = ${key} AND membership_ts < ${timestamp}`;
	}

	/** Records that the bot was removed from a chat (a `leave` event); a blocked chat stays blocked. */
	async markLeft(key: string, timestamp: number): Promise<void> {
		await this.#sql`UPDATE line_sources
			SET membership_ts = ${timestamp},
				status = CASE WHEN status = 'blocked' THEN status ELSE 'left' END,
				status_changed_at = CASE WHEN status = 'blocked' THEN status_changed_at ELSE ${this.#now()} END
			WHERE source_key = ${key} AND membership_ts < ${timestamp}`;
	}
}
