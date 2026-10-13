import type { SQL } from "bun";
import { type ParsedEvent, parseSourceKey } from "./events.ts";
import type { SourceStatus } from "./sources.ts";

/** What persisting one request did, in counts. */
export interface IntakeResult {
	/** Events kept for the inbox worker. */
	queued: number;
	/** Events dropped unread because their chat is not allowed (or they name none). */
	skipped: number;
	/** Events an earlier delivery had already stored. */
	duplicates: number;
}

/**
 * Events that carry no customer content, only the fact that the bot came or went. They are kept for
 * a chat that is not allowed too: a join is answered with a notice whatever the allowlist says, and
 * a leave keeps the chat's status true.
 */
const MEMBERSHIP = new Set(["join", "leave"]);

/**
 * PostgreSQL refuses U+0000 in text and in JSONB, and a lone surrogate in JSONB; either would fail
 * the whole request's transaction and with it every other event stored beside this one. They are
 * replaced with U+FFFD, which loses nothing a chat mirror could use.
 */
function clean(text: string): string {
	return text.replaceAll("\u0000", "\uFFFD").toWellFormed();
}

function scrub(value: unknown): unknown {
	if (typeof value === "string") return clean(value);
	if (Array.isArray(value)) return value.map(scrub);
	if (typeof value === "object" && value !== null)
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [clean(key), scrub(item)]),
		);
	return value;
}

/** Why an event is dropped, or undefined when it is kept. */
function dropReason(
	event: ParsedEvent,
	status: SourceStatus | undefined,
): string | undefined {
	if (!event.active) return "standby";
	if (status === undefined) return "no_source";
	if (status === "allowed") return undefined;
	if (status !== "blocked" && MEMBERSHIP.has(event.type)) return undefined;
	return status === "blocked" ? "source_blocked" : "source_not_allowed";
}

/**
 * Stores a request's events in one transaction, so the caller may answer `200` once this returns.
 * An unknown chat is recorded as pending with counts only; the content of an event of a chat that
 * is not allowed is never written. An event already stored (same `webhookEventId`) is left as it
 * is, so a redelivery is processed once.
 */
export async function persistEvents(
	sql: SQL,
	events: readonly ParsedEvent[],
	now: Date,
): Promise<IntakeResult> {
	const result: IntakeResult = { queued: 0, skipped: 0, duplicates: 0 };
	// Sorted, so two requests that share chats take their locks in one order and cannot deadlock.
	const keys = [
		...new Set(events.flatMap((e) => (e.sourceKey ? [e.sourceKey] : []))),
	].sort();
	await sql.begin(async (tx) => {
		const statuses = new Map<string, SourceStatus>();
		for (const key of keys) {
			const source = parseSourceKey(key);
			if (!source) continue;
			await tx`INSERT INTO line_sources
				(source_key, kind, status, first_seen_at, last_seen_at, status_changed_at)
				VALUES (${key}, ${source.kind}, 'pending', ${now}, ${now}, ${now})
				ON CONFLICT (source_key) DO NOTHING`;
		}
		if (keys.length > 0) {
			// The row locks last to the end of the request: allow() and block() wait, so each event meets one status.
			const rows: { source_key: string; status: SourceStatus }[] =
				await tx`SELECT source_key, status FROM line_sources
					WHERE source_key IN ${tx(keys)} ORDER BY source_key FOR UPDATE`;
			for (const row of rows) statuses.set(row.source_key, row.status);
		}
		for (const event of events) {
			const status = event.sourceKey
				? statuses.get(event.sourceKey)
				: undefined;
			const reason = dropReason(event, status);
			const payload = reason ? null : JSON.stringify(scrub(event.raw));
			const id = clean(event.id);
			const type = clean(event.type);
			const messageId =
				event.messageId === null ? null : clean(event.messageId);
			const inserted: { webhook_event_id: string }[] =
				await tx`INSERT INTO line_inbox
				(webhook_event_id, source_key, event_type, message_id, event_ts, payload, status,
				 next_attempt_at, last_error_code, created_at, completed_at)
				VALUES (${id}, ${event.sourceKey}, ${type}, ${messageId}, ${event.timestamp},
					${payload}::text::jsonb, ${reason ? "skipped" : "pending"}, ${now}, ${reason ?? null}, ${now},
					${reason ? now : null})
				ON CONFLICT (webhook_event_id) DO NOTHING
				RETURNING webhook_event_id`;
			if (inserted.length === 0) {
				result.duplicates++;
				continue;
			}
			if (reason) result.skipped++;
			else result.queued++;
			if (event.sourceKey)
				await tx`UPDATE line_sources
					SET last_seen_at = ${now}, event_count = event_count + 1,
						message_count = message_count + ${event.type === "message" ? 1 : 0}
					WHERE source_key = ${event.sourceKey}`;
		}
	});
	return result;
}
