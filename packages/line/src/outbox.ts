import { randomUUID } from "node:crypto";
import type { SQL } from "bun";
import { LineError } from "./errors.ts";
import { parseSourceKey } from "./events.ts";
import { scrub } from "./intake.ts";
import {
	type LineSender,
	SENDER_DEFAULTS,
	type SenderOptions,
	validateSender,
} from "./sender.ts";
import type { LineSources } from "./sources.ts";

/** A message object as LINE takes it, such as `{ type: "text", text: "hello" }`. */
export type LineOutMessage = { type: string } & Record<string, unknown>;

export interface EnqueueOptions {
	/** The name and icon the push is shown under; validated before anything is queued. */
	sender?: LineSender;
	/**
	 * Your own reference for this enqueue (at most 200 characters), given back as the `originRef` of
	 * the `outboxResult` event of the push that carries it.
	 */
	origin?: string;
}

/** Pushes to the chats the allowlist admits. */
export interface LineOutbox {
	/**
	 * Queues message objects for a chat. Objects queued for the same chat and the same sender within
	 * `outbox.coalesceMs` (2 seconds) share a push of at most five, in the order they were queued; a
	 * push is held back behind earlier pushes to the chat. Each push has its retry key from the
	 * moment it exists. How a push ends comes back to the subscriber as an `outboxResult` event.
	 *
	 * Throws `LineError` before queuing anything: `bad_sender` for a sender LINE would refuse,
	 * `bad_messages` for an object that cannot be sent, `bad_source_key`, and `source_not_allowed`
	 * for a chat that is not on the allowlist.
	 */
	enqueue(
		sourceKey: string,
		messages: readonly LineOutMessage[],
		options?: EnqueueOptions,
	): Promise<void>;
}

export interface OutboxOptions {
	/** How long the objects of one chat and sender are gathered into one push; default 2 seconds. */
	coalesceMs: number;
	/** Attempts after which a push that keeps failing is dead; default 12. */
	maxAttempts: number;
	/** First backoff; each failure doubles it up to `backoffCapMs`; default 5 seconds. */
	backoffBaseMs: number;
	/** Longest backoff; default 1 hour. */
	backoffCapMs: number;
	/**
	 * How long a retry key is reused after the first attempt; default 24 hours, LINE's limit. A push
	 * still unsent then is dead, and is never sent under a new key.
	 */
	retryKeyMs: number;
	/** How long the worker waits between looks at the outbox when nothing woke it; default 1 second. */
	pollMs: number;
	/** How long a push may be in hand before another worker may take it; default 2 minutes. */
	leaseMs: number;
	/** Pushes sent at once, always to different chats; default 2. */
	concurrency: number;
}

export const OUTBOX_DEFAULTS: OutboxOptions = {
	coalesceMs: 2_000,
	maxAttempts: 12,
	backoffBaseMs: 5_000,
	backoffCapMs: 60 * 60_000,
	retryKeyMs: 24 * 60 * 60_000,
	pollMs: 1_000,
	leaseMs: 2 * 60_000,
	concurrency: 2,
};

const MAX_TIMER_MS = 2_147_483_647;

/** Refuses a mistake in the outbox options, naming the field. */
export function checkOutboxOptions(options: Partial<OutboxOptions>): void {
	for (const [key, value] of Object.entries(options)) {
		if (!(key in OUTBOX_DEFAULTS))
			throw new Error(`line: outbox.${key} is not an outbox option`);
		const min = key === "coalesceMs" ? 0 : 1;
		if (!Number.isInteger(value) || (value as number) < min)
			throw new Error(
				`line: outbox.${key} must be a whole number of at least ${min}; got ${String(value)}`,
			);
		if (
			["coalesceMs", "pollMs", "leaseMs"].includes(key) &&
			(value as number) > MAX_TIMER_MS
		)
			throw new Error(
				`line: outbox.${key} must be at most ${MAX_TIMER_MS} milliseconds; got ${String(value)}`,
			);
	}
}

/** The most message objects one push holds. */
export const PUSH_MAX_MESSAGES = 5;
const MAX_CALL_MESSAGES = 100;
const MAX_TEXT_CHARS = 5000;
const MAX_MESSAGE_BYTES = 50_000;
const MAX_ORIGIN_CHARS = 200;

const badMessages = (what: string): LineError =>
	new LineError("bad_messages", `line: ${what}`);

/** The message objects as they will be stored: plain, serialisable, with no sender of their own. */
function checkMessages(messages: readonly LineOutMessage[]): LineOutMessage[] {
	if (
		!Array.isArray(messages) ||
		messages.length === 0 ||
		messages.length > MAX_CALL_MESSAGES
	)
		throw badMessages(
			`enqueue takes 1 to ${MAX_CALL_MESSAGES} message objects at a time`,
		);
	return messages.map((message, index) => {
		if (
			typeof message !== "object" ||
			message === null ||
			Array.isArray(message) ||
			typeof message.type !== "string" ||
			message.type === ""
		)
			throw badMessages(`message ${index} is not a LINE message object`);
		if ("sender" in message)
			throw badMessages(
				`message ${index} names a sender; give the sender to enqueue`,
			);
		if (
			message.type === "text" &&
			(typeof message.text !== "string" ||
				message.text.trim() === "" ||
				message.text.length > MAX_TEXT_CHARS)
		)
			throw badMessages(
				`message ${index} is text of 1 to ${MAX_TEXT_CHARS} characters`,
			);
		let cleaned: LineOutMessage;
		let size: number;
		try {
			cleaned = scrub(message) as LineOutMessage;
			size = JSON.stringify(cleaned).length;
		} catch {
			throw badMessages(`message ${index} cannot be serialised`);
		}
		if (size > MAX_MESSAGE_BYTES)
			throw badMessages(`message ${index} is over ${MAX_MESSAGE_BYTES} bytes`);
		return cleaned;
	});
}

function checkOrigin(origin: string | undefined): string | null {
	if (origin === undefined) return null;
	if (
		typeof origin !== "string" ||
		origin === "" ||
		origin.length > MAX_ORIGIN_CHARS
	)
		throw badMessages(
			`origin is a string of 1 to ${MAX_ORIGIN_CHARS} characters`,
		);
	return scrub(origin) as string;
}

export interface PgOutboxDeps {
	sql: SQL;
	now: () => Date;
	sources: LineSources;
	options?: Partial<OutboxOptions>;
	sender?: Partial<SenderOptions>;
	/** Told after a push is queued, with how long until it is ready to go, so the worker looks then. */
	queued?: (readyInMs: number) => void;
}

/**
 * The queue. A push exists from its first object, with its retry key already stored; later objects
 * join it while it is open (gathered for `coalesceMs`, fewer than five objects, still the last push to
 * its chat, not yet tried), then it is sealed by being tried.
 */
export class PgOutbox implements LineOutbox {
	readonly #sql: SQL;
	readonly #now: () => Date;
	readonly #sources: LineSources;
	readonly #senderOptions: SenderOptions;
	readonly #coalesceMs: number;
	readonly #queued: ((readyInMs: number) => void) | undefined;

	constructor(deps: PgOutboxDeps) {
		this.#sql = deps.sql;
		this.#now = deps.now;
		this.#sources = deps.sources;
		this.#senderOptions = { ...SENDER_DEFAULTS, ...deps.sender };
		this.#coalesceMs = deps.options?.coalesceMs ?? OUTBOX_DEFAULTS.coalesceMs;
		this.#queued = deps.queued;
	}

	async enqueue(
		sourceKey: string,
		messages: readonly LineOutMessage[],
		options: EnqueueOptions = {},
	): Promise<void> {
		if (!parseSourceKey(sourceKey))
			throw new LineError(
				"bad_source_key",
				"line: a source key is line:<group|room|user>:<id>",
			);
		const sender = validateSender(options.sender, this.#senderOptions);
		let rest = checkMessages(messages);
		const origin = checkOrigin(options.origin);
		if ((await this.#sources.get(sourceKey))?.status !== "allowed")
			throw new LineError(
				"source_not_allowed",
				"line: a push goes only to a chat on the allowlist",
			);
		const name = sender?.name ?? null;
		const icon = sender?.iconUrl ?? null;
		const now = this.#now();
		const window = new Date(now.getTime() + this.#coalesceMs);
		// A push that fills goes at once; one that is still gathering is ready when its window ends.
		let filled = false;
		let gathering = false;
		await this.#sql.begin(async (tx) => {
			// One enqueue at a time per chat, so pushes of a chat are formed in order.
			await tx`SELECT pg_advisory_xact_lock(hashtextextended(${sourceKey}, 13))`;
			const [open] =
				(await tx`SELECT id, message_count, origin_refs, ready_at FROM line_outbox
				WHERE source_key = ${sourceKey}
					AND id = (SELECT max(id) FROM line_outbox WHERE source_key = ${sourceKey})
					AND sender_name IS NOT DISTINCT FROM ${name}::text
					AND sender_icon_url IS NOT DISTINCT FROM ${icon}::text
					AND status = 'queued' AND first_attempt_at IS NULL AND ready_at > ${now}
				FOR UPDATE`) as {
					id: string | number;
					message_count: number;
					origin_refs: (string | null)[];
					ready_at: Date;
				}[];
			if (open && open.message_count < PUSH_MAX_MESSAGES) {
				const take = rest.slice(0, PUSH_MAX_MESSAGES - open.message_count);
				rest = rest.slice(take.length);
				const origins = [...new Set([...open.origin_refs, origin])];
				const full = open.message_count + take.length >= PUSH_MAX_MESSAGES;
				filled ||= full;
				await tx`UPDATE line_outbox
					SET messages = messages || ${JSON.stringify(take)}::text::jsonb,
						message_count = message_count + ${take.length},
						origin_refs = ${JSON.stringify(origins)}::text::jsonb,
						ready_at = ${full ? now : open.ready_at}
					WHERE id = ${open.id}`;
			}
			while (rest.length > 0) {
				const take = rest.slice(0, PUSH_MAX_MESSAGES);
				rest = rest.slice(take.length);
				const full = take.length >= PUSH_MAX_MESSAGES;
				if (full) filled = true;
				else gathering = true;
				await tx`INSERT INTO line_outbox
					(source_key, sender_name, sender_icon_url, messages, message_count, origin_refs, retry_key,
					 status, created_at, ready_at, next_attempt_at)
					VALUES (${sourceKey}, ${name}, ${icon}, ${JSON.stringify(take)}::text::jsonb, ${take.length},
						${JSON.stringify([origin])}::text::jsonb, ${randomUUID()}::uuid, 'queued', ${now},
						${full ? now : window}, ${now})`;
			}
		});
		if (filled) this.#queued?.(0);
		if (gathering || !filled) this.#queued?.(this.#coalesceMs);
	}
}
