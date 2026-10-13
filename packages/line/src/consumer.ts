import type { SQL } from "bun";
import type { Logger } from "pi-roundtable";
import { LineError } from "./errors.ts";
import type { InboxEvent, InboxProcessor, InboxResult } from "./inbox.ts";
import {
	type LineContext,
	type LineEditedEvent,
	type LineMessageEvent,
	type LineSubscriber,
	type LineUnsentEvent,
	messageOf,
	nonEmpty,
	readBody,
	readMembers,
	senderOf,
} from "./messages.ts";

/** The most references a subscriber may return for one message, and the longest one. */
const MAX_REFS = 100;
const MAX_REF_CHARS = 512;

export interface ConsumerDeps {
	sql: SQL;
	logger: Logger;
	now: () => Date;
}

const checkRef = (ref: unknown): string => {
	if (
		typeof ref !== "string" ||
		ref === "" ||
		ref.length > MAX_REF_CHARS ||
		ref.includes("\u0000")
	)
		throw new LineError(
			"bad_refs",
			`line: a ref is a non-empty string of at most ${MAX_REF_CHARS} characters`,
		);
	return ref;
};

const tooManyRefs = (): LineError =>
	new LineError(
		"bad_refs",
		`line: a message may have at most ${MAX_REFS} refs`,
	);

/**
 * The references a subscriber answered, checked: strings that PostgreSQL can store, once each, in
 * order. Nothing is a message with no references to add; anything else than `{ refs }` is refused,
 * so an answer meant as something else (a retry request, say) is not taken for a mirror.
 */
function cleanRefs(answer: unknown): string[] {
	if (answer === undefined) return [];
	if (typeof answer !== "object" || answer === null || !("refs" in answer))
		throw new LineError(
			"bad_refs",
			"line: a subscriber answers a message with { refs } or nothing; to give up, throw",
		);
	const refs: unknown = answer.refs;
	if (!Array.isArray(refs) || refs.length > MAX_REFS) throw tooManyRefs();
	return [...new Set(refs.map(checkRef))];
}

/** The context of an event that keeps nothing. */
const NO_KEEP: LineContext = {
	keep: async () => {
		throw new LineError(
			"keep_unavailable",
			"line: references are kept only while a message is being mirrored",
		);
	},
};

/** A token PostgreSQL can store, or null. */
const storable = (value: unknown): string | null => {
	const text = nonEmpty(value);
	return text && !text.includes("\u0000") ? text : null;
};

/** The lock that orders everything that decides the fate of one message. */
const lockOf = (sourceKey: string, messageId: string): string =>
	`${sourceKey} ${messageId}`;

/**
 * Turns inbox events into the typed events of the one subscriber and keeps what is needed to take a
 * mirror back: the references the subscriber returned, and a tombstone for every unsent message.
 *
 * Everything that decides what happens to one message (storing its references, writing its
 * tombstone) runs under one advisory lock, so an unsend and a mirror in flight cannot both miss each
 * other: either the references are stored first and the unsend hands them over, or the tombstone is
 * written first and the mirror finds it and is taken back at once.
 *
 * Delivery is at least once, so every step is safe to repeat. The references of an unsent message
 * stay stored until the subscriber has taken them back, so a subscriber that failed halfway is handed
 * the same references again.
 */
export class LineConsumer {
	readonly #sql: SQL;
	readonly #logger: Logger;
	readonly #now: () => Date;

	constructor(deps: ConsumerDeps) {
		this.#sql = deps.sql;
		this.#logger = deps.logger;
		this.#now = deps.now;
	}

	/** An inbox processor that hands typed events to `handler`. */
	processorFor(handler: LineSubscriber): InboxProcessor {
		return async (event, signal) => this.#process(handler, event, signal);
	}

	async #process(
		handler: LineSubscriber,
		event: InboxEvent,
		signal: AbortSignal,
	): Promise<InboxResult> {
		const sourceKey = event.sourceKey;
		if (!sourceKey) {
			this.#logger.warn(
				{ event: event.id, type: event.type },
				"a LINE event names no chat and was skipped",
			);
			return undefined;
		}
		const base = {
			eventId: event.id,
			sourceKey,
			timestamp: event.timestamp,
		};
		switch (event.type) {
			case "message":
				await this.#message(handler, event, sourceKey, signal);
				return undefined;
			case "messageEdited":
				await this.#edited(handler, event, sourceKey, signal);
				return undefined;
			case "unsend":
				await this.#unsent(handler, event, sourceKey, signal);
				return undefined;
			case "join":
				// The notice is sent by a later release; until then it is never confirmed.
				await handler(
					{ type: "joined", ...base, notice: "unconfirmed" },
					signal,
					NO_KEEP,
				);
				return undefined;
			case "leave":
				await handler({ type: "left", ...base }, signal, NO_KEEP);
				return undefined;
			case "memberJoined":
			case "memberLeft": {
				const joined = event.type === "memberJoined";
				const userIds = readMembers(event.payload, joined ? "joined" : "left");
				if (userIds.length > 0)
					await handler(
						{ type: event.type, ...base, userIds },
						signal,
						NO_KEEP,
					);
				return undefined;
			}
			default:
				// follow, postback, beacon and the like carry nothing a mirror shows.
				return undefined;
		}
	}

	async #message(
		handler: LineSubscriber,
		event: InboxEvent,
		sourceKey: string,
		signal: AbortSignal,
	): Promise<void> {
		const messageId = event.messageId;
		if (!messageId)
			throw new LineError("bad_message", "line: a message event has no id");
		if (await this.#tombstoned(sourceKey, messageId)) {
			// An unsent message is not mirrored. References left over from a mirror that was cut short
			// are still handed back, so the post they name is taken down.
			await this.#retract(handler, event, sourceKey, messageId, signal, false);
			this.#logger.info(
				{ event: event.id },
				"a LINE message that was unsent is not mirrored",
			);
			return;
		}
		if (await this.#mirrored(sourceKey, messageId)) return;
		const message = messageOf(event.payload);
		const userId = senderOf(event.payload);
		const quoted = nonEmpty(message.quotedMessageId);
		const typed: LineMessageEvent = {
			type: "message",
			eventId: event.id,
			sourceKey,
			timestamp: event.timestamp,
			messageId,
			...(userId ? { userId } : {}),
			body: readBody(message),
			...(quoted ? { quotedMessageId: quoted } : {}),
		};
		// Refs the sender's unsend already took back through `keep`; they are not handed back twice.
		const takenBack = new Set<string>();
		const context: LineContext = {
			keep: async (ref) => {
				const unsent = await this.#keep(sourceKey, messageId, checkRef(ref));
				if (unsent) {
					takenBack.add(ref);
					await this.#retract(
						handler,
						event,
						sourceKey,
						messageId,
						signal,
						false,
					);
				}
				return { unsent };
			},
		};
		const refs = cleanRefs(await handler(typed, signal, context)).filter(
			(ref) => !takenBack.has(ref),
		);
		const late = await this.#store(event, sourceKey, messageId, typed, refs);
		if (late) {
			// An unsend landed while the subscriber was mirroring: take the new mirror back at once.
			await this.#retract(handler, event, sourceKey, messageId, signal, false);
			this.#logger.info(
				{ event: event.id },
				"a LINE message was unsent while it was mirrored and was taken back",
			);
		}
	}

	/**
	 * Stores one reference the subscriber has just made, under the message's lock. True when the
	 * message has been unsent: the reference is stored all the same, so it can be handed back.
	 */
	async #keep(
		sourceKey: string,
		messageId: string,
		ref: string,
	): Promise<boolean> {
		const now = this.#now();
		return this.#sql.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockOf(sourceKey, messageId)}, 11))`;
			await this.#addRefs(tx, sourceKey, messageId, [ref], now);
			return this.#tombstonedIn(tx, sourceKey, messageId);
		});
	}

	/** Adds references after the ones stored, in order; one already stored keeps its place. The lock is held. */
	async #addRefs(
		tx: SQL,
		sourceKey: string,
		messageId: string,
		refs: readonly string[],
		now: Date,
	): Promise<void> {
		for (const ref of refs)
			await tx`INSERT INTO line_message_refs (source_key, message_id, ref, position, created_at)
				SELECT ${sourceKey}, ${messageId}, ${ref}, COALESCE(MAX(position) + 1, 0), ${now}
				FROM line_message_refs WHERE source_key = ${sourceKey} AND message_id = ${messageId}
				ON CONFLICT (source_key, message_id, ref) DO NOTHING`;
		const [count] = (await tx`SELECT count(*)::int AS n FROM line_message_refs
			WHERE source_key = ${sourceKey} AND message_id = ${messageId}`) as {
			n: number;
		}[];
		if ((count?.n ?? 0) > MAX_REFS) throw tooManyRefs();
	}

	/**
	 * Keeps the message and the references it answered, unless it has been unsent meanwhile, in which
	 * case only the references are kept (so they can be handed back) and true is returned.
	 */
	async #store(
		event: InboxEvent,
		sourceKey: string,
		messageId: string,
		typed: LineMessageEvent,
		refs: readonly string[],
	): Promise<boolean> {
		const now = this.#now();
		const message = messageOf(event.payload);
		const replyToken = storable(event.payload.replyToken);
		const quoteToken = storable(message.quoteToken);
		return this.#sql.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockOf(sourceKey, messageId)}, 11))`;
			const unsent = await this.#tombstonedIn(tx, sourceKey, messageId);
			if (!unsent)
				await tx`INSERT INTO line_messages
					(source_key, message_id, message_type, event_ts, reply_token, reply_token_at, quote_token, created_at)
					VALUES (${sourceKey}, ${messageId}, ${typed.body.kind}, ${event.timestamp},
						${replyToken}, ${replyToken ? new Date(event.timestamp) : null}, ${quoteToken}, ${now})
					ON CONFLICT (source_key, message_id) DO NOTHING`;
			await this.#addRefs(tx, sourceKey, messageId, refs, now);
			return unsent;
		});
	}

	async #edited(
		handler: LineSubscriber,
		event: InboxEvent,
		sourceKey: string,
		signal: AbortSignal,
	): Promise<void> {
		const messageId = event.messageId;
		if (!messageId)
			throw new LineError("bad_message", "line: an edit event has no id");
		if (await this.#tombstoned(sourceKey, messageId)) return;
		const [row] = (await this.#sql`SELECT edit_ts FROM line_messages
			WHERE source_key = ${sourceKey} AND message_id = ${messageId}`) as {
			edit_ts: string | number;
		}[];
		if (!row) {
			// The original was never mirrored (it died, or it is older than retention): nothing to edit.
			this.#logger.info(
				{ event: event.id },
				"a LINE edit of a message that is not mirrored was skipped",
			);
			return;
		}
		// Edits may arrive out of order; the one with the largest time is the latest state.
		if (Number(row.edit_ts) >= event.timestamp) return;
		const message = messageOf(event.payload);
		if (message.type !== "text" || typeof message.text !== "string") return;
		const typed: LineEditedEvent = {
			type: "edited",
			eventId: event.id,
			sourceKey,
			timestamp: event.timestamp,
			messageId,
			text: message.text,
			refs: await this.#refs(sourceKey, messageId),
		};
		await handler(typed, signal, NO_KEEP);
		await this
			.#sql`UPDATE line_messages SET edit_ts = GREATEST(edit_ts, ${event.timestamp})
			WHERE source_key = ${sourceKey} AND message_id = ${messageId}`;
	}

	async #unsent(
		handler: LineSubscriber,
		event: InboxEvent,
		sourceKey: string,
		signal: AbortSignal,
	): Promise<void> {
		const messageId = event.messageId;
		if (!messageId)
			throw new LineError("bad_message", "line: an unsend event has no id");
		const now = this.#now();
		await this.#sql.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockOf(sourceKey, messageId)}, 11))`;
			await tx`INSERT INTO line_tombstones (source_key, message_id, created_at)
				VALUES (${sourceKey}, ${messageId}, ${now})
				ON CONFLICT (source_key, message_id) DO NOTHING`;
			// Whatever the message said is gone, wherever a copy waits: the event itself, edits of it.
			await tx`UPDATE line_inbox SET payload = NULL
				WHERE source_key = ${sourceKey} AND message_id = ${messageId} AND payload IS NOT NULL`;
			// Its metadata (tokens, type) goes too; the references stay until they have been handed back.
			await tx`DELETE FROM line_messages WHERE source_key = ${sourceKey} AND message_id = ${messageId}`;
		});
		await this.#retract(handler, event, sourceKey, messageId, signal, true);
	}

	/**
	 * Hands the stored references of a message to the subscriber as `unsent`, then forgets them.
	 * Without `always` nothing is handed over when there are no references: the subscriber has the
	 * unsend event itself, and has nothing of this message to take back.
	 */
	async #retract(
		handler: LineSubscriber,
		event: InboxEvent,
		sourceKey: string,
		messageId: string,
		signal: AbortSignal,
		always: boolean,
	): Promise<void> {
		const refs = await this.#refs(sourceKey, messageId);
		if (refs.length === 0 && !always) return;
		const typed: LineUnsentEvent = {
			type: "unsent",
			eventId: event.id,
			sourceKey,
			timestamp: event.timestamp,
			messageId,
			refs,
		};
		await handler(typed, signal, NO_KEEP);
		if (refs.length > 0)
			await this.#sql`DELETE FROM line_message_refs
				WHERE source_key = ${sourceKey} AND message_id = ${messageId} AND ref IN ${this.#sql([...refs])}`;
	}

	async #refs(sourceKey: string, messageId: string): Promise<string[]> {
		const rows: { ref: string }[] = await this
			.#sql`SELECT ref FROM line_message_refs
			WHERE source_key = ${sourceKey} AND message_id = ${messageId} ORDER BY position, ref`;
		return rows.map((row) => row.ref);
	}

	async #tombstoned(sourceKey: string, messageId: string): Promise<boolean> {
		return this.#tombstonedIn(this.#sql, sourceKey, messageId);
	}

	async #tombstonedIn(
		sql: SQL,
		sourceKey: string,
		messageId: string,
	): Promise<boolean> {
		const rows = await sql`SELECT 1 FROM line_tombstones
			WHERE source_key = ${sourceKey} AND message_id = ${messageId}`;
		return rows.length > 0;
	}

	async #mirrored(sourceKey: string, messageId: string): Promise<boolean> {
		const rows = await this.#sql`SELECT 1 FROM line_messages
			WHERE source_key = ${sourceKey} AND message_id = ${messageId}`;
		return rows.length > 0;
	}
}
