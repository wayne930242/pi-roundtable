import type { SQL } from "bun";
import type { Claimed } from "./inbox-types.ts";

/** Claims the oldest due event of a chat with none in hand, under the chat's advisory lock; see `InboxWorker`. */
export async function claimNext(
	sql: SQL,
	now: Date,
): Promise<Claimed | undefined> {
	return sql.begin(async (tx) => {
		// A chat the bot left, or one not decided, hands out only its join, leave and unsend. What else
		// waits there (it was backing off when the chat changed) is dropped with its payload, because
		// it could otherwise surface much later, after a rejoin. An unsend carries no content and only
		// takes content down, so it is kept.
		await tx`UPDATE line_inbox i
			SET status = 'skipped', payload = NULL, last_error_code = CASE s.status WHEN 'left' THEN 'source_left' ELSE 'source_pending' END,
				completed_at = ${now}
			FROM line_sources s
			WHERE s.source_key = i.source_key AND s.status IN ('pending', 'left')
				AND i.status = 'pending' AND i.event_type NOT IN ('join', 'leave', 'unsend')`;
		// The oldest due event of each chat that has none in hand, and the events that name no chat.
		const heads: {
			webhook_event_id: string;
			source_key: string | null;
			event_ts: string | number;
			seq: string | number;
			source_status: string | null;
		}[] =
			await tx`(SELECT DISTINCT ON (i.source_key) i.webhook_event_id, i.source_key, i.event_ts, i.seq,
						s.status AS source_status
					FROM line_inbox i
					JOIN line_sources s ON s.source_key = i.source_key
					WHERE i.status = 'pending' AND i.next_attempt_at <= ${now} AND i.source_key IS NOT NULL
						AND (s.status IN ('allowed', 'blocked')
							OR (s.status IN ('pending', 'left') AND i.event_type IN ('join', 'leave', 'unsend')))
						AND NOT EXISTS (SELECT 1 FROM line_inbox p WHERE p.source_key = i.source_key AND p.status = 'processing')
					ORDER BY i.source_key, i.event_ts, i.seq)
				UNION ALL
				(SELECT i.webhook_event_id, i.source_key, i.event_ts, i.seq, NULL AS source_status FROM line_inbox i
					WHERE i.status = 'pending' AND i.next_attempt_at <= ${now} AND i.source_key IS NULL
					ORDER BY i.event_ts, i.seq LIMIT 20)`;
		heads.sort(
			(x, y) =>
				Number(x.event_ts) - Number(y.event_ts) ||
				Number(x.seq) - Number(y.seq),
		);
		for (const head of heads) {
			if (head.source_key) {
				// Every claimer takes the chat's lock before it looks at the chat's events, so none claims
				// an event that has an older one in front of it; a busy lock means another worker has the chat.
				const [lock] =
					(await tx`SELECT pg_try_advisory_xact_lock(hashtextextended(${head.source_key}, 7)) AS held`) as {
						held: boolean;
					}[];
				if (!lock?.held) continue;
				const [busy] = (await tx`SELECT 1 AS busy FROM line_inbox
					WHERE source_key = ${head.source_key} AND status = 'processing' LIMIT 1`) as unknown[];
				if (busy) continue;
				if (head.source_status === "blocked") {
					// What a blocked chat still has waiting is never handed out; the chat is left to the next look.
					await tx`UPDATE line_inbox
						SET status = 'skipped', payload = NULL, last_error_code = 'source_blocked', completed_at = ${now}
						WHERE source_key = ${head.source_key} AND status = 'pending'
							AND EXISTS (SELECT 1 FROM line_sources WHERE source_key = ${head.source_key} AND status = 'blocked')`;
					continue;
				}
			}
			// Locked, then claimed: a row another transaction holds (a block, say) is left to it.
			const claimed: Claimed[] = await tx`UPDATE line_inbox
				SET status = 'processing', claimed_at = ${now}, attempts = attempts + 1
				WHERE webhook_event_id = (
					SELECT webhook_event_id FROM line_inbox
					WHERE webhook_event_id = ${head.webhook_event_id} AND status = 'pending' AND next_attempt_at <= ${now}
					FOR UPDATE SKIP LOCKED)
				RETURNING seq, webhook_event_id, source_key, event_type, message_id, event_ts, payload,
					attempts, requeues, created_at, claimed_at`;
			if (claimed[0]) return claimed[0];
		}
		return undefined;
	});
}
